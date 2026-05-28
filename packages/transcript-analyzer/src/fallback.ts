/**
 * 多段 fallback 経路
 *
 * 順序（contracts.md §7.3）：
 *   1. cache hit                 → 即返却（caller 側で実施。本ファイルは Gemini 経路のみ扱う）
 *   2. Gemini 2.5 Flash 全文      → 成功なら "miss" を返す
 *   3. chunk 分割再試行           → 成功なら "fallback_chunk"
 *   4. fallbackModel              → 成功なら "fallback_model"（モデルは Gemini 系のみ。Sonnet 禁止）
 *   5. 全段失敗                   → "failure" を返却（answer は明示メッセージ）
 *
 * 重要：Sonnet 全文 fallback は実装しない。本ファイルでも明示的に
 * 「primaryModel / fallbackModel が gemini- 系であること」を確認する。
 */

import { GeminiAuthMissingError, GeminiCallError, type GeminiClient } from "./gemini-client.js";
import { buildAnalyzePrompt } from "./prompt-injection-guard.js";
import {
  type AnswerScope,
  assertAllowedGeminiModel,
  type CacheStatus,
  type GeminiFailureKind,
} from "./types.js";

export interface FallbackOptions {
  /** 主モデル（例：gemini-2.5-flash） */
  primaryModel: string;
  /** fallback model（gemini- 系のみ。Sonnet / claude 禁止） */
  fallbackModel: string;
  /** chunk 分割時の 1 chunk の最大文字数 */
  chunkMaxChars?: number;
}

export interface FallbackResult {
  /** Gemini 応答の raw JSON */
  rawJson: string;
  /** 使った model 名 */
  model: string;
  /** 観測値 */
  costUsd: number;
  /** 経路結果 */
  cacheStatus: Extract<CacheStatus, "miss" | "fallback_chunk" | "fallback_model" | "failure">;
  /** Gemini 失敗の経路を warnings へ流す用 */
  warnings: string[];
  /** failure 時に caller が messages に明示するための kind */
  lastFailureKind?: GeminiFailureKind;
}

const DEFAULT_CHUNK_MAX_CHARS = 12_000;

/**
 * Gemini fallback 経路を実行する。
 *
 * Sonnet 全文 fallback は呼ばない。primaryModel / fallbackModel が
 * gemini- 系でないことを runtime check で弾く。
 */
export async function runWithFallback(
  client: GeminiClient,
  transcriptContent: string,
  userQuery: string,
  options: FallbackOptions,
): Promise<FallbackResult> {
  assertAllowedGeminiModel(options.primaryModel);
  assertAllowedGeminiModel(options.fallbackModel);

  const warnings: string[] = [];
  let billableCostUsd = 0;

  // ステップ 1：primary 全文
  try {
    const prompt = buildAnalyzePrompt(transcriptContent, userQuery);
    const res = await client.generateContent(prompt, options.primaryModel);
    billableCostUsd += res.costUsd;
    return {
      rawJson: res.rawJson,
      model: res.model,
      costUsd: billableCostUsd,
      cacheStatus: "miss",
      warnings,
    };
  } catch (err) {
    const kind = classifyFallbackError(err);
    warnings.push(`primary_model_failed:${kind}`);
    if (kind === "auth_missing") {
      return {
        rawJson: "",
        model: options.primaryModel,
        costUsd: billableCostUsd,
        cacheStatus: "failure",
        warnings,
        lastFailureKind: kind,
      };
    }

    // ステップ 2：chunk 分割で primary を再試行
    const chunkResult = await tryChunkSplit(
      client,
      transcriptContent,
      userQuery,
      options.primaryModel,
      options.chunkMaxChars ?? DEFAULT_CHUNK_MAX_CHARS,
    );
    if (chunkResult.ok) {
      return {
        rawJson: chunkResult.rawJson,
        model: chunkResult.model,
        costUsd: chunkResult.costUsd,
        cacheStatus: "fallback_chunk",
        warnings: [...warnings, ...chunkResult.warnings],
      };
    }
    billableCostUsd += chunkResult.costUsd;
    warnings.push(...chunkResult.warnings);
    if (chunkResult.nonRetryableFailureKind) {
      return {
        rawJson: "",
        model: options.primaryModel,
        costUsd: billableCostUsd,
        cacheStatus: "failure",
        warnings,
        lastFailureKind: chunkResult.nonRetryableFailureKind,
      };
    }

    // ステップ 3：fallbackModel を全文で試行
    try {
      const prompt2 = buildAnalyzePrompt(transcriptContent, userQuery);
      const res2 = await client.generateContent(prompt2, options.fallbackModel);
      billableCostUsd += res2.costUsd;
      return {
        rawJson: res2.rawJson,
        model: res2.model,
        costUsd: billableCostUsd,
        cacheStatus: "fallback_model",
        warnings: [...warnings, `fallback_model_used:${options.fallbackModel}`],
      };
    } catch (err2) {
      const kind2 = classifyFallbackError(err2);
      warnings.push(`fallback_model_failed:${kind2}`);

      // ステップ 4：全段失敗
      return {
        rawJson: "",
        model: options.fallbackModel,
        costUsd: billableCostUsd,
        cacheStatus: "failure",
        warnings,
        lastFailureKind: kind2,
      };
    }
  }
}

interface ChunkResult {
  ok: boolean;
  rawJson: string;
  model: string;
  costUsd: number;
  warnings: string[];
  nonRetryableFailureKind?: Extract<GeminiFailureKind, "auth_missing">;
}

async function tryChunkSplit(
  client: GeminiClient,
  transcriptContent: string,
  userQuery: string,
  modelName: string,
  chunkMaxChars: number,
): Promise<ChunkResult> {
  if (transcriptContent.length <= chunkMaxChars) {
    // 既に十分小さい → chunk 分割しても効果なし
    return {
      ok: false,
      rawJson: "",
      model: modelName,
      costUsd: 0,
      warnings: ["chunk_split_skipped:content_smaller_than_chunk_size"],
    };
  }

  const chunks = splitIntoChunks(transcriptContent, chunkMaxChars);
  const parsedChunks: GeminiChunkShape[] = [];
  let totalCost = 0;
  const warnings: string[] = [`chunk_split_used:${chunks.length}_chunks`];
  let byteOffset = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkPrompt = buildAnalyzePrompt(
      chunk,
      `${userQuery}\n\n(注：これは transcript の ${i + 1}/${chunks.length} の chunk です)`,
    );
    try {
      const res = await client.generateContent(chunkPrompt, modelName);
      totalCost += res.costUsd;
      const parsed = parseGeminiChunkJson(res.rawJson);
      if (!parsed) {
        warnings.push(`chunk_${i + 1}_parse_failed`);
        return { ok: false, rawJson: "", model: modelName, costUsd: totalCost, warnings };
      }
      parsedChunks.push(offsetChunkCitations(parsed, byteOffset));
    } catch (err) {
      const kind = classifyFallbackError(err);
      warnings.push(`chunk_${i + 1}_failed:${kind}`);
      // chunk が 1 つでも全失敗したら fallback 失敗扱い
      return {
        ok: false,
        rawJson: "",
        model: modelName,
        costUsd: totalCost,
        warnings,
        nonRetryableFailureKind: kind === "auth_missing" ? kind : undefined,
      };
    }
    byteOffset += Buffer.byteLength(chunk, "utf8");
  }

  return {
    ok: true,
    rawJson: JSON.stringify(mergeChunkResponses(parsedChunks)),
    model: modelName,
    costUsd: totalCost,
    warnings,
  };
}

function classifyFallbackError(err: unknown): GeminiFailureKind {
  if (err instanceof GeminiAuthMissingError) return "auth_missing";
  if (err instanceof GeminiCallError) return err.kind;
  return "500";
}

interface GeminiChunkShape {
  answer?: string;
  citations?: Array<{
    transcript_id?: string;
    chunk_id?: string;
    byte_range?: [number, number];
    excerpt?: string;
  }>;
  used_chunks?: string[];
  answer_scope?: AnswerScope;
  confidence?: number;
  confidence_reason?: string;
  warnings?: string[];
  open_questions?: string[];
}

function parseGeminiChunkJson(rawJson: string): GeminiChunkShape | null {
  const stripped = rawJson
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "");
  try {
    return JSON.parse(stripped) as GeminiChunkShape;
  } catch {
    const match = stripped.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as GeminiChunkShape;
    } catch {
      return null;
    }
  }
}

function offsetChunkCitations(parsed: GeminiChunkShape, byteOffset: number): GeminiChunkShape {
  const citations = Array.isArray(parsed.citations)
    ? parsed.citations.map((c) => {
        if (!Array.isArray(c.byte_range) || c.byte_range.length !== 2) return c;
        return {
          ...c,
          byte_range: [c.byte_range[0] + byteOffset, c.byte_range[1] + byteOffset] as [
            number,
            number,
          ],
        };
      })
    : parsed.citations;
  return { ...parsed, citations };
}

function mergeChunkResponses(chunks: GeminiChunkShape[]): GeminiChunkShape {
  const answers: string[] = [];
  const citations: NonNullable<GeminiChunkShape["citations"]> = [];
  const usedChunks = new Set<string>();
  const warnings: string[] = [];
  const openQuestions = new Set<string>();
  const confidenceValues: number[] = [];
  let answerScope: AnswerScope = "not_found";

  for (const chunk of chunks) {
    if (typeof chunk.answer === "string" && chunk.answer.trim().length > 0) {
      answers.push(chunk.answer.trim());
    }
    if (Array.isArray(chunk.citations)) citations.push(...chunk.citations);
    if (Array.isArray(chunk.used_chunks)) {
      for (const used of chunk.used_chunks) {
        if (typeof used === "string") usedChunks.add(used);
      }
    }
    if (chunk.answer_scope === "explicit") answerScope = "explicit";
    else if (chunk.answer_scope === "inferred" && answerScope !== "explicit") {
      answerScope = "inferred";
    }
    if (typeof chunk.confidence === "number" && Number.isFinite(chunk.confidence)) {
      confidenceValues.push(chunk.confidence);
    }
    if (typeof chunk.confidence_reason === "string" && chunk.confidence_reason.length > 0) {
      warnings.push(`chunk_confidence_reason:${chunk.confidence_reason}`);
    }
    if (Array.isArray(chunk.warnings)) {
      for (const warning of chunk.warnings) {
        if (typeof warning === "string") warnings.push(warning);
      }
    }
    if (Array.isArray(chunk.open_questions)) {
      for (const question of chunk.open_questions) {
        if (typeof question === "string") openQuestions.add(question);
      }
    }
  }

  const confidence =
    confidenceValues.length > 0
      ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length
      : undefined;

  return {
    answer: answers.join("\n"),
    citations,
    used_chunks: Array.from(usedChunks),
    answer_scope: answerScope,
    confidence,
    confidence_reason: "chunk fallback merged multiple Gemini responses",
    warnings,
    open_questions: Array.from(openQuestions),
  };
}

/**
 * transcript を chunk_max_chars で分割する。境界は改行優先で寄せる。
 */
export function splitIntoChunks(content: string, chunkMaxChars: number): string[] {
  if (chunkMaxChars <= 0) return [content];
  const chunks: string[] = [];
  let i = 0;
  while (i < content.length) {
    const end = Math.min(i + chunkMaxChars, content.length);
    // 改行で寄せる（最後の改行を探す）
    let cutAt = end;
    if (end < content.length) {
      const newline = content.lastIndexOf("\n", end);
      if (newline > i + chunkMaxChars / 2) {
        cutAt = newline;
      }
    }
    chunks.push(content.slice(i, cutAt));
    i = cutAt;
  }
  return chunks;
}
