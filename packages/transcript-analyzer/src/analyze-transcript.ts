/**
 * T3: transcript_analyzer_analyze_transcript
 *
 * transcript 全文を Gemini 2.5 Flash で読み込み、query に対する answer + citations を抽出する。
 *
 * 経路（contracts.md §7.3）：
 *   1. cache hit  → hit
 *   2. quota 不足 → quota_exceeded
 *   3. Gemini 2.5 Flash → miss
 *   4. chunk 分割 → fallback_chunk
 *   5. fallbackModel → fallback_model
 *   6. 全段失敗 → failure（TTL 5 分）
 *
 * 重要：
 * - Sonnet 全文 fallback は実装しない（fallback.ts で type レベルでも禁止）
 * - excerpt は redact 後に 500 文字 / 合計 2000 文字に制限
 * - prompt injection 検出は warnings に追加（block しない）
 * - citation の byte_range は post-validate（不正は warning 追加 + drop）
 */

import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { type CacheStore, computeFileHash, computeQueryHash } from "./cache.js";
import { runWithFallback } from "./fallback.js";
import { GeminiAuthMissingError, GeminiCallError, type GeminiClient } from "./gemini-client.js";
import { detectPromptInjection, isCitationByteRangeValid } from "./prompt-injection-guard.js";
import type { QuotaStore } from "./quota.js";
import {
  applyExcerptLimits,
  MAX_EXCERPT_CHARS_PER_CITATION,
  redactSensitive,
} from "./redaction.js";
import type {
  AnalyzeTranscriptRequest,
  AnalyzeTranscriptResponse,
  AnswerScope,
  Citation,
  Redaction,
  ResolvedConfig,
} from "./types.js";

export interface AnalyzeTranscriptDeps {
  config: ResolvedConfig;
  cacheStore: CacheStore;
  quotaStore: QuotaStore;
  geminiClient: GeminiClient;
  sessionId: string;
  metrics?: (name: string, labels?: Record<string, string>) => void;
  now?: () => Date;
}

/** Gemini が返す JSON のおおまかな shape（parse 後 validation 用） */
interface GeminiResponseShape {
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

/**
 * analyze_transcript 実装。caller は session_id・config・dependencies を渡す。
 */
export async function analyzeTranscript(
  req: AnalyzeTranscriptRequest,
  deps: AnalyzeTranscriptDeps,
): Promise<AnalyzeTranscriptResponse> {
  const config = deps.config;
  const now = (deps.now ?? (() => new Date()))();
  const transcriptId = typeof req?.transcript_id === "string" ? req.transcript_id : "";
  const userQuery = typeof req?.query === "string" ? req.query : "";

  // ステップ 0：argument 検証
  if (transcriptId.length === 0 || userQuery.length === 0) {
    return buildFailureResponse(
      config,
      `transcript-analyzer: transcript_id と query は必須です`,
      [],
      "quota_exceeded" /* 形式失敗 */,
    );
  }

  // ステップ 1：transcript ファイル特定（id は file_hash の prefix）
  const fileInfo = await locateTranscriptById(config.transcriptDir, transcriptId);
  if (!fileInfo) {
    return buildFailureResponse(
      config,
      "transcript-analyzer: 指定された transcript_id に対応する transcript が見つかりません",
      [],
      "failure",
    );
  }

  // ステップ 2：cache lookup（0 コストの hit は quota 超過後も利用可能）
  const queryHash = computeQueryHash(userQuery);
  const cacheKey = {
    file_hash: fileInfo.fileHash,
    query_hash: queryHash,
    model: config.model,
    prompt_version: config.promptVersion,
  };
  const cached = await deps.cacheStore.get(cacheKey, now);
  if (cached) {
    deps.metrics?.("transcript_analyzer.analyze_called", { cache_status: "hit" });
    // cache hit は consumeCall せず即返却（再課金 0）。contracts.md §4.4「重複イベント」
    return { ...cached, cache_status: "hit" };
  }

  // ステップ 3：quota check（cache miss 時のみ）
  const quotaCheck = deps.quotaStore.check(
    deps.sessionId,
    fileInfo.fileHash,
    {
      maxAnalyzePerSession: config.maxAnalyzePerSession,
      maxAnalyzePerFilePerDay: config.maxAnalyzePerFilePerDay,
      monthlySpendCapUsd: config.monthlySpendCapUsd,
    },
    now,
  );

  if (!quotaCheck.allowed) {
    deps.metrics?.("transcript_analyzer.analyze_called", { cache_status: "quota_exceeded" });
    return {
      answer: "transcript-analyzer の利用上限に到達しました。明日以降に再試行してください",
      citations: [],
      used_chunks: [],
      redactions: [],
      answer_scope: "not_found",
      confidence: 0,
      confidence_reason: `quota_exceeded:${quotaCheck.reason}`,
      model: config.model,
      cache_status: "quota_exceeded",
      prompt_version: config.promptVersion,
      warnings: [`quota_exceeded:${quotaCheck.reason ?? "unknown"}`],
      open_questions: [],
    };
  }

  // ステップ 4：quota consume（cache miss 時のみ加算）
  deps.quotaStore.consumeCall(deps.sessionId, fileInfo.fileHash, now);

  // ステップ 5：Gemini API 呼び出し（多段 fallback）
  const transcriptContent = fileInfo.content;
  const transcriptByteLength = Buffer.byteLength(transcriptContent, "utf8");
  const injectionTokens = detectPromptInjection(transcriptContent);
  const injectionWarnings = injectionTokens.map((t) => `prompt_injection_detected:${t}`);

  let fallbackResult: Awaited<ReturnType<typeof runWithFallback>>;
  try {
    fallbackResult = await runWithFallback(deps.geminiClient, transcriptContent, userQuery, {
      primaryModel: config.model,
      fallbackModel: config.fallbackModel,
    });
  } catch (err) {
    // auth_missing 等の例外は failure として明示
    const message = err instanceof Error ? err.message : String(err);
    deps.metrics?.("transcript_analyzer.gemini_failure", { failure_kind: "auth_missing" });
    const failureResp = buildFailureResponse(
      config,
      "cost-guard: transcript の解析に失敗しました。後でもう一度お試しください",
      [...injectionWarnings, `gemini_call_failed:${classifyExceptionMessage(message)}`],
      "failure",
    );
    await deps.cacheStore.put(cacheKey, failureResp, now);
    return failureResp;
  }

  // metric 更新
  if (fallbackResult.cacheStatus === "fallback_chunk") {
    deps.metrics?.("transcript_analyzer.fallback_used", { fallback_kind: "chunk" });
  } else if (fallbackResult.cacheStatus === "fallback_model") {
    deps.metrics?.("transcript_analyzer.fallback_used", { fallback_kind: "model" });
  }
  deps.metrics?.("transcript_analyzer.analyze_called", {
    cache_status: fallbackResult.cacheStatus,
  });
  if (fallbackResult.costUsd > 0) {
    deps.metrics?.("transcript_analyzer.spend_usd_total");
  }

  // ステップ 6：全段失敗時の処理
  if (fallbackResult.cacheStatus === "failure") {
    if (fallbackResult.costUsd > 0) {
      deps.quotaStore.addSpend(fallbackResult.costUsd, now);
    }
    deps.metrics?.("transcript_analyzer.gemini_failure", {
      failure_kind: fallbackResult.lastFailureKind ?? "500",
    });
    const failureResp = buildFailureResponse(
      config,
      "cost-guard: transcript の解析に失敗しました。後でもう一度お試しください",
      [...injectionWarnings, ...fallbackResult.warnings],
      "failure",
    );
    await deps.cacheStore.put(cacheKey, failureResp, now);
    return failureResp;
  }

  if (fallbackResult.costUsd > 0) {
    deps.quotaStore.addSpend(fallbackResult.costUsd, now);
  }

  // ステップ 7：Gemini 応答 parse + validate + redact
  const parsed = safeParseGeminiJson(fallbackResult.rawJson);
  const response = assembleResponse({
    parsed,
    cacheStatus: fallbackResult.cacheStatus,
    transcriptId,
    transcriptContent,
    transcriptByteLength,
    config,
    modelUsed: fallbackResult.model,
    extraWarnings: [...injectionWarnings, ...fallbackResult.warnings],
  });

  // ステップ 8：成功 cache 保存
  await deps.cacheStore.put(cacheKey, response, now);
  return response;
}

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

interface LocatedTranscript {
  fileHash: string;
  content: string;
  fullPath: string;
}

async function locateTranscriptById(
  transcriptDir: string,
  transcriptId: string,
): Promise<LocatedTranscript | null> {
  let entries: string[];
  let transcriptDirRealPath: string;
  try {
    entries = readdirSync(transcriptDir, { withFileTypes: false }) as string[];
    transcriptDirRealPath = realpathSync(transcriptDir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (typeof name !== "string") continue;
    if (name.startsWith(".")) continue;
    const fullPath = join(transcriptDir, name);
    try {
      if (!lstatSync(fullPath).isFile()) continue;
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
    if (fileHash.slice(0, 16) === transcriptId) {
      return { fileHash, content, fullPath };
    }
  }
  return null;
}

function isWithinDirectory(childPath: string, parentPath: string): boolean {
  const rel = relative(parentPath, childPath);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

function safeParseGeminiJson(rawJson: string): GeminiResponseShape {
  if (typeof rawJson !== "string" || rawJson.length === 0) return {};
  // Gemini が ```json ... ``` で囲んで返すケースに対応
  const stripped = rawJson
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "");
  try {
    return JSON.parse(stripped) as GeminiResponseShape;
  } catch {
    // 複数 chunk 連結のケース：最初の { ... } を抜き出す
    const match = stripped.match(/\{[\s\S]*\}/);
    if (!match) return {};
    try {
      return JSON.parse(match[0]) as GeminiResponseShape;
    } catch {
      return {};
    }
  }
}

interface AssembleParams {
  parsed: GeminiResponseShape;
  cacheStatus: "miss" | "fallback_chunk" | "fallback_model";
  transcriptId: string;
  transcriptContent: string;
  transcriptByteLength: number;
  config: ResolvedConfig;
  modelUsed: string;
  extraWarnings: string[];
}

function assembleResponse(p: AssembleParams): AnalyzeTranscriptResponse {
  const warnings: string[] = [...p.extraWarnings];
  const redactions: Redaction[] = [];

  // citation の post-validate + redact
  const rawCitations = Array.isArray(p.parsed.citations) ? p.parsed.citations : [];
  const validCitations: Array<{
    transcript_id: string;
    chunk_id: string;
    byte_range: [number, number];
    rawExcerpt: string;
  }> = [];

  for (const c of rawCitations) {
    if (!c || typeof c !== "object") continue;
    const transcriptIdField =
      typeof c.transcript_id === "string" ? c.transcript_id : p.transcriptId;
    const chunkId = typeof c.chunk_id === "string" ? c.chunk_id : "";
    const byteRange = c.byte_range;
    if (!isCitationByteRangeValid(byteRange, p.transcriptByteLength)) {
      warnings.push(
        `citation_byte_range_invalid:${chunkId || "(no chunk_id)"}:${JSON.stringify(byteRange ?? null)}`,
      );
      continue;
    }
    const rawExcerpt = typeof c.excerpt === "string" ? c.excerpt : "";
    if (rawExcerpt.length === 0) continue;
    if (
      extractTranscriptExcerpt(p.transcriptContent, byteRange as [number, number]) !== rawExcerpt
    ) {
      warnings.push(
        `citation_excerpt_mismatch:${chunkId || "(no chunk_id)"}:${JSON.stringify(byteRange)}`,
      );
      continue;
    }
    validCitations.push({
      transcript_id: transcriptIdField,
      chunk_id: chunkId,
      byte_range: byteRange as [number, number],
      rawExcerpt,
    });
  }

  // redact + 500 文字 / 合計 2000 文字制限
  const redactedExcerpts: string[] = [];
  for (const c of validCitations) {
    const trimmed = c.rawExcerpt.slice(0, MAX_EXCERPT_CHARS_PER_CITATION);
    const { text: redactedExcerpt, redactions: r } = redactSensitive(trimmed);
    redactions.push(...r);
    redactedExcerpts.push(redactedExcerpt);
  }
  const limitedExcerpts = applyExcerptLimits(redactedExcerpts);
  const citations: Citation[] = validCitations.map((c, i) => ({
    transcript_id: c.transcript_id,
    chunk_id: c.chunk_id,
    byte_range: c.byte_range,
    excerpt: limitedExcerpts[i] ?? "",
  }));

  // answer は redact（個人名等が answer に直接埋め込まれるリスクへの対処）
  const rawAnswer = typeof p.parsed.answer === "string" ? p.parsed.answer : "";
  const { text: redactedAnswer, redactions: ar } = redactSensitive(rawAnswer);
  redactions.push(...ar);

  const usedChunks = citations.map((c) => c.chunk_id).filter((s) => s.length > 0);

  let answerScope: AnswerScope = "not_found";
  if (p.parsed.answer_scope === "explicit" || p.parsed.answer_scope === "inferred") {
    answerScope = p.parsed.answer_scope;
  } else if (redactedAnswer.trim().length > 0 && citations.length > 0) {
    answerScope = "explicit";
  } else if (redactedAnswer.trim().length > 0) {
    answerScope = "inferred";
  }

  const confidence =
    typeof p.parsed.confidence === "number" &&
    Number.isFinite(p.parsed.confidence) &&
    p.parsed.confidence >= 0 &&
    p.parsed.confidence <= 1
      ? p.parsed.confidence
      : answerScope === "not_found"
        ? 0
        : 0.5;

  const confidenceReason =
    typeof p.parsed.confidence_reason === "string"
      ? p.parsed.confidence_reason
      : answerScope === "not_found"
        ? "transcript に該当箇所が見つかりませんでした"
        : `Gemini ${p.modelUsed} による分析結果`;

  const openQuestions = Array.isArray(p.parsed.open_questions)
    ? p.parsed.open_questions.filter((s): s is string => typeof s === "string")
    : [];

  // parser warnings / Gemini 由来 warning の集約
  if (Array.isArray(p.parsed.warnings)) {
    for (const w of p.parsed.warnings) {
      if (typeof w === "string") warnings.push(w);
    }
  }

  return {
    answer: redactedAnswer,
    citations,
    used_chunks: usedChunks,
    redactions,
    answer_scope: answerScope,
    confidence,
    confidence_reason: confidenceReason,
    model: p.modelUsed,
    cache_status: p.cacheStatus,
    prompt_version: p.config.promptVersion,
    warnings,
    open_questions: openQuestions,
  };
}

function extractTranscriptExcerpt(transcriptContent: string, byteRange: [number, number]): string {
  const transcriptBytes = Buffer.from(transcriptContent, "utf8");
  return transcriptBytes.subarray(byteRange[0], byteRange[1]).toString("utf8");
}

function buildFailureResponse(
  config: ResolvedConfig,
  message: string,
  warnings: string[],
  cacheStatus: "failure" | "quota_exceeded",
): AnalyzeTranscriptResponse {
  return {
    answer: message,
    citations: [],
    used_chunks: [],
    redactions: [],
    answer_scope: "not_found",
    confidence: 0,
    confidence_reason: cacheStatus,
    model: config.model,
    cache_status: cacheStatus,
    prompt_version: config.promptVersion,
    warnings,
    open_questions: [],
  };
}

function classifyExceptionMessage(message: string): string {
  if (message.includes("API key missing")) return "auth_missing";
  if (message.toLowerCase().includes("429")) return "429";
  if (message.toLowerCase().includes("timeout")) return "timeout";
  return "500";
}

// 補助 export（test 用）
export { GeminiAuthMissingError, GeminiCallError };
