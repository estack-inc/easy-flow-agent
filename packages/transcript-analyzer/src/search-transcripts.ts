/**
 * T2: transcript-analyzer.search_transcripts
 *
 * query に関連する transcript chunk を BM25 風スコアで top-k 返す。
 * Phase 1 は keyword 一致ベース（structured search の代用）の実装。
 * Phase 2 で pgvector embedding 検索に置き換え予定。
 *
 * 引数：SearchTranscriptsRequest { query, top_k? }
 * 戻り値：SearchTranscriptsResponse { chunks: TranscriptChunk[], total_found }
 *
 * Phase 1 設計：
 * - transcriptDir 配下を chunk size 512 byte で分割
 * - query を normalize して tokenize（空白区切り）
 * - 各 chunk の token 一致数 / chunk 長で score 算出
 * - score desc で top_k（既定 10）
 */

import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { computeFileHash, normalizeQuery } from "./cache.js";
import type {
  SearchTranscriptsRequest,
  SearchTranscriptsResponse,
  TranscriptChunk,
} from "./types.js";

export interface SearchTranscriptsDeps {
  transcriptDir: string;
}

const CHUNK_SIZE_BYTES = 512;
const DEFAULT_TOP_K = 10;

/**
 * search_transcripts 実装。
 *
 * Phase 1 は file 走査ベースの単純検索。Phase 2 で pgvector embedding 検索に置換。
 */
export async function searchTranscripts(
  req: SearchTranscriptsRequest,
  deps: SearchTranscriptsDeps,
): Promise<SearchTranscriptsResponse> {
  const query = typeof req?.query === "string" ? req.query : "";
  const topK =
    typeof req?.top_k === "number" && req.top_k > 0 && Number.isFinite(req.top_k)
      ? Math.floor(req.top_k)
      : DEFAULT_TOP_K;

  if (query.length === 0) {
    return { chunks: [], total_found: 0 };
  }

  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) {
    return { chunks: [], total_found: 0 };
  }

  let entries: string[];
  let transcriptDirRealPath: string;
  try {
    entries = readdirSync(deps.transcriptDir, { withFileTypes: false }) as string[];
    transcriptDirRealPath = realpathSync(deps.transcriptDir);
  } catch {
    return { chunks: [], total_found: 0 };
  }

  const allChunks: TranscriptChunk[] = [];
  for (const name of entries) {
    if (typeof name !== "string") continue;
    if (name.startsWith(".")) continue;
    const fullPath = join(deps.transcriptDir, name);
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(fullPath);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;
    try {
      if (!isWithinDirectory(realpathSync(fullPath), transcriptDirRealPath)) continue;
    } catch {
      continue;
    }

    let content: string;
    try {
      content = readFileSync(fullPath, "utf8");
    } catch {
      continue;
    }

    const fileHash = computeFileHash(content);
    const transcriptId = fileHash.slice(0, 16);

    // chunk 分割
    const buf = Buffer.from(content, "utf8");
    const fileSize = buf.length;
    let chunkIndex = 0;
    for (let offset = 0; offset < fileSize; offset += CHUNK_SIZE_BYTES) {
      const end = Math.min(offset + CHUNK_SIZE_BYTES, fileSize);
      // utf8 境界調整を簡易に行う：byte 境界が文字途中なら次の境界まで含める
      const chunkContent = buf.slice(offset, end).toString("utf8");
      const score = computeKeywordScore(chunkContent, tokens);
      if (score > 0) {
        allChunks.push({
          transcript_id: transcriptId,
          chunk_id: `${transcriptId}-c${chunkIndex}`,
          byte_range: [offset, end],
          score,
        });
      }
      chunkIndex++;
    }
  }

  allChunks.sort((a, b) => b.score - a.score);
  const topChunks = allChunks.slice(0, topK);

  return { chunks: topChunks, total_found: allChunks.length };
}

function tokenizeQuery(query: string): string[] {
  const normalized = normalizeQuery(query).toLowerCase();
  if (normalized.length === 0) return [];
  // 空白 / 句読点 区切り
  return normalized
    .split(/[\s、。．，,.;:!?！？]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * BM25 風の単純な keyword score（Phase 1）。
 *
 * score = sum_over_tokens(occurrence_count) / log(chunk_byte_size + 10)
 *
 * 0.0 - 1.0 に min/max clamp する。
 */
function computeKeywordScore(chunkContent: string, tokens: string[]): number {
  if (chunkContent.length === 0 || tokens.length === 0) return 0;
  const lower = chunkContent.toLowerCase();
  let occurrenceTotal = 0;
  for (const tok of tokens) {
    if (tok.length === 0) continue;
    let count = 0;
    let from = 0;
    while (true) {
      const idx = lower.indexOf(tok, from);
      if (idx === -1) break;
      count++;
      from = idx + tok.length;
    }
    occurrenceTotal += count;
  }
  if (occurrenceTotal === 0) return 0;
  const raw = occurrenceTotal / Math.log(chunkContent.length + 10);
  // クリップ
  if (raw > 1) return 1;
  if (raw < 0) return 0;
  return raw;
}

function isWithinDirectory(childPath: string, parentPath: string): boolean {
  const rel = relative(parentPath, childPath);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}
