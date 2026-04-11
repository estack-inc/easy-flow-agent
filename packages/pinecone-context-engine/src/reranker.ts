import type { ChunkMetadata } from "@easy-flow/pinecone-client";

export interface RankedChunk {
  id: string;
  text: string;
  /** re-ranking 後の最終スコア */
  score: number;
  /** Pinecone のベクトル類似度 */
  originalScore: number;
  metadata: ChunkMetadata;
}

const SOURCE_TYPE_WEIGHTS: Record<ChunkMetadata["sourceType"], number> = {
  agents_rule: 1.0,
  memory_file: 0.8,
  session_turn: 0.6,
  workflow_state: 0.5,
};

const VECTOR_WEIGHT = 0.7;
const SOURCE_WEIGHT = 0.2;
const FRESHNESS_WEIGHT = 0.1;

/** 線形減衰で鮮度スコアを計算（作成直後 = 1.0、7 日以上前 = 0.0） */
const FRESHNESS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function computeFreshnessScore(createdAt: number, now: number): number {
  const age = now - createdAt;
  if (age <= 0) return 1.0;
  if (age >= FRESHNESS_MAX_AGE_MS) return 0.0;
  return 1.0 - age / FRESHNESS_MAX_AGE_MS;
}

/**
 * Pinecone 検索結果に re-ranking を適用する。
 *
 * 最終スコア = ベクトル類似度 × 0.7 + sourceType 重み × 0.2 + 鮮度スコア × 0.1
 *
 * 同一テキストの重複はスコアが高い方を残す。
 */
export function rerankChunks(
  chunks: Array<{ id: string; text: string; score: number; metadata: ChunkMetadata }>,
  now: number = Date.now(),
): RankedChunk[] {
  if (chunks.length === 0) return [];

  const scored: RankedChunk[] = chunks.map((chunk) => {
    const sourceWeight = SOURCE_TYPE_WEIGHTS[chunk.metadata.sourceType] ?? 0.5;
    const freshnessScore = computeFreshnessScore(chunk.metadata.createdAt, now);

    const finalScore =
      chunk.score * VECTOR_WEIGHT +
      sourceWeight * SOURCE_WEIGHT +
      freshnessScore * FRESHNESS_WEIGHT;

    return {
      id: chunk.id,
      text: chunk.text,
      score: finalScore,
      originalScore: chunk.score,
      metadata: chunk.metadata,
    };
  });

  // 重複排除: 同一テキストのチャンクはスコアが高い方を残す
  const deduped = new Map<string, RankedChunk>();
  for (const chunk of scored) {
    const existing = deduped.get(chunk.text);
    if (!existing || chunk.score > existing.score) {
      deduped.set(chunk.text, chunk);
    }
  }

  // スコア降順でソート
  return [...deduped.values()].sort((a, b) => b.score - a.score);
}
