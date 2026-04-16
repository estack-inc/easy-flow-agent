import type { QueryResult } from "@easy-flow/pinecone-client";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens } from "./token-estimator.js";

/**
 * Extract text from an AgentMessage content field.
 *
 * - If `content` is a string, return it as-is.
 * - If `content` is an array, extract `text` fields from `type: "text"` entries,
 *   filtering out `toolCall`, `toolResult`, `thinking`, and other non-text types.
 * - Returns empty string for `[]`, non-text-only arrays, or unrecognized formats.
 */
export function extractMessageText(content: AgentMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const texts: string[] = [];
  for (const part of content) {
    if (
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string"
    ) {
      texts.push(part.text);
    }
  }
  return texts.join("\n");
}

export const DEFAULT_SKIP_PATTERNS = [
  "記憶しないで",
  "覚えなくていい",
  "覚えないで",
  "no memory",
  "skip memory",
  "dont remember",
  "don't remember",
  "skip ingest",
  // System noise patterns
  "NO_REPLY",
  "HEARTBEAT_OK",
  "変更なしスキップ",
];

export const RECENT_TURNS_FOR_QUERY = 3;
export const DEFAULT_TOP_K = 10;
export const DEFAULT_MIN_SCORE = 0.75;
/**
 * Default token budget for Pinecone memory injection.
 * Set to 16000 to accommodate Japanese/CJK conversations, which use
 * ~1.5 tokens/char (after PR #16 fix). This allows ~10,000 Japanese
 * characters per context injection (comparable to pre-fix behavior).
 */
export const DEFAULT_TOKEN_BUDGET = 16000;
export const DEFAULT_MIN_QUERY_TOKENS = 20;
export const DEFAULT_INGEST_ROLES: ("user" | "assistant")[] = ["user", "assistant"];
export const DEFAULT_COMPACT_AFTER_DAYS = 7;

export const RETRY_BASE_MS = 100;
export const MAX_RETRIES = 3;
export const ASSEMBLE_TIMEOUT_MS = 5000;

// --- RAG mode defaults ---
export const DEFAULT_RAG_TOKEN_BUDGET = 2000;
export const DEFAULT_RAG_MIN_SCORE = 0.75;
export const DEFAULT_RAG_TOP_K = 10;

/**
 * Default maximum tokens for the query text sent to Embedding API.
 * Gemini text-embedding-004 accepts up to 2,048 tokens; 1,024 provides
 * a safety margin while covering normal conversation lengths.
 */
export const DEFAULT_MAX_QUERY_TOKENS = 1024;

/**
 * Minimum positive value for maxQueryTokens.
 * CJK characters need ~2 tokens each, so at least 2 tokens are required
 * to represent a single character query.
 */
const MIN_POSITIVE_MAX_QUERY_TOKENS = 2;

/**
 * Resolve the effective maxQueryTokens value from env var, param, and default.
 *
 * Priority: RAG_MAX_QUERY_TOKENS env > param > DEFAULT_MAX_QUERY_TOKENS.
 * `0` means "unlimited". Negative values and NaN fall through to the next source.
 * Positive values below MIN_POSITIVE_MAX_QUERY_TOKENS are clamped up.
 */
export function resolveMaxQueryTokens(paramValue?: number): number {
  const envRaw = process.env.RAG_MAX_QUERY_TOKENS;
  if (envRaw !== undefined) {
    const parsed = Number(envRaw);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      return clampMaxQueryTokens(parsed);
    }
  }
  if (paramValue !== undefined && paramValue >= 0) {
    return clampMaxQueryTokens(paramValue);
  }
  return DEFAULT_MAX_QUERY_TOKENS;
}

function clampMaxQueryTokens(value: number): number {
  if (value === 0) return 0; // unlimited
  return Math.max(value, MIN_POSITIVE_MAX_QUERY_TOKENS);
}

/**
 * Determine if a query is "thin" — too short or lacking proper nouns to
 * produce good Pinecone vector-search results.
 */
export function isQueryThin(query: string, minTokens: number = DEFAULT_MIN_QUERY_TOKENS): boolean {
  const tokens = estimateTokens(query);
  const hasProperNoun = /[A-Z\u4E00-\u9FFF\u30A0-\u30FF]/.test(query);
  return tokens < minTokens || !hasProperNoun;
}

/**
 * Enrich a thin query by appending a memoryHint suffix.
 * Returns the original query unchanged if it is already rich enough.
 */
export function buildEnrichedQuery(
  baseQuery: string,
  memoryHint?: string,
  minTokens: number = DEFAULT_MIN_QUERY_TOKENS,
): string {
  if (!isQueryThin(baseQuery, minTokens) || !memoryHint) {
    return baseQuery;
  }
  return `${baseQuery}\n${memoryHint.slice(0, 200)}`;
}

export function isRateLimitError(err: unknown): boolean {
  if (err && typeof err === "object") {
    if ("status" in err && (err as { status: number }).status === 429) return true;
    if (
      "message" in err &&
      typeof (err as { message: string }).message === "string" &&
      (err as { message: string }).message.includes("429")
    )
      return true;
  }
  return false;
}

/**
 * Retry with exponential backoff on 429 rate limit errors.
 * Initial attempt + up to MAX_RETRIES retries = MAX_RETRIES + 1 total attempts.
 * Backoff: 100ms → 200ms → 400ms.
 */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  const maxAttempts = MAX_RETRIES + 1; // initial + 3 retries = 4 attempts
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRateLimitError(err) || attempt === maxAttempts - 1) {
        throw err;
      }
      const delay = RETRY_BASE_MS * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

export function buildQueryFromRecentTurns(messages: AgentMessage[]): string {
  const recent = messages.slice(-RECENT_TURNS_FOR_QUERY);
  const texts = recent.map((m) => extractMessageText(m.content)).filter((t) => t.length > 0);
  return texts.join("\n");
}

export interface TruncationResult {
  query: string;
  truncated: boolean;
  originalTokens: number;
  truncatedTokens: number;
  turnsUsed: number;
  turnsTotal: number;
}

/**
 * Build a query from recent turns with token-budget truncation.
 *
 * When the full query exceeds `maxTokens`, turns are selected from newest
 * to oldest. The most recent message is always included (truncated at the
 * character level if it alone exceeds the budget). `maxTokens <= 0` disables
 * truncation (unlimited).
 */
export function buildQueryWithTruncation(
  messages: AgentMessage[],
  maxTokens: number,
): TruncationResult {
  const recent = messages.slice(-RECENT_TURNS_FOR_QUERY);
  const texts = recent.map((m) => extractMessageText(m.content)).filter((t) => t.length > 0);
  const fullQuery = texts.join("\n");
  const originalTokens = estimateTokens(fullQuery);

  // maxTokens <= 0 means unlimited
  if (maxTokens <= 0 || originalTokens <= maxTokens) {
    return {
      query: fullQuery,
      truncated: false,
      originalTokens,
      truncatedTokens: originalTokens,
      turnsUsed: texts.length,
      turnsTotal: messages.length,
    };
  }

  // Iterate from newest turn, accumulating within budget.
  // Use estimateTokens on the joined candidate text to avoid
  // over-counting from per-turn Math.ceil rounding and separator approximation.
  const selected: string[] = [];

  for (let i = texts.length - 1; i >= 0; i--) {
    const text = texts[i];

    if (i === texts.length - 1) {
      // Most recent message — always include, truncate text if needed
      if (estimateTokens(text) > maxTokens) {
        selected.push(truncateTextToTokenBudget(text, maxTokens));
      } else {
        selected.push(text);
      }
      continue;
    }

    // Check if adding this turn would exceed the budget
    const candidate = [text, ...selected].join("\n");
    if (estimateTokens(candidate) > maxTokens) {
      break;
    }
    selected.unshift(text);
  }

  // selected is already in chronological order (unshift for older, push for newest)

  const truncatedQuery = selected.join("\n");
  return {
    query: truncatedQuery,
    truncated: true,
    originalTokens,
    truncatedTokens: estimateTokens(truncatedQuery),
    turnsUsed: selected.length,
    turnsTotal: messages.length,
  };
}

/**
 * Truncate text to fit within a token budget by removing characters from the end.
 */
function truncateTextToTokenBudget(text: string, maxTokens: number): string {
  let tokens = 0;
  let endIndex = 0;

  for (const char of text) {
    const code = char.codePointAt(0)!;
    let charTokens: number;
    if (code <= 0x7f) {
      charTokens = 0.25;
    } else if (
      (code >= 0x3000 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      charTokens = 1.5;
    } else if (code >= 0xff00 && code <= 0xffef) {
      charTokens = 1.0;
    } else {
      charTokens = 1.0;
    }

    if (Math.ceil(tokens + charTokens) > maxTokens) break;
    tokens += charTokens;
    endIndex += char.length;
  }

  return text.slice(0, endIndex);
}

export async function readOldTurns(
  sessionFile: string,
  cutoffTimestamp: number,
): Promise<AgentMessage[]> {
  try {
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(sessionFile, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);

    const oldMessages: AgentMessage[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        // Session entries have a timestamp field
        if (
          entry.timestamp &&
          entry.timestamp < cutoffTimestamp &&
          entry.message &&
          typeof entry.message.role === "string" &&
          entry.message.content !== undefined
        ) {
          oldMessages.push(entry.message);
        }
      } catch {
        // Skip malformed lines
      }
    }
    return oldMessages;
  } catch {
    return [];
  }
}

/**
 * AGENTS-CORE.md をファイルシステムから読み込む。
 * ファイルが存在しない場合は空文字を返す。
 */
export async function readAgentsCore(filePath: string): Promise<string> {
  try {
    const { readFile } = await import("node:fs/promises");
    return await readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

/**
 * RAG モードの systemPromptAddition を組み立てる。
 *
 * AGENTS-CORE.md 固定テキスト + re-ranking 済み動的チャンクをトークン予算内でマージ。
 */
export function buildRagSystemPromptAddition(
  agentsCoreText: string,
  dynamicChunks: Array<{ text: string; score: number }>,
  dynamicBudget: number,
  precomputedCoreTokens?: number,
): { markdown: string; coreTokens: number; dynamicTokens: number } {
  const parts: string[] = [];
  let coreTokens = 0;

  if (agentsCoreText) {
    parts.push(agentsCoreText);
    coreTokens = precomputedCoreTokens ?? estimateTokens(agentsCoreText);
  }

  const selectedTexts: string[] = [];
  let dynamicTokens = 0;

  for (const chunk of dynamicChunks) {
    const tokens = estimateTokens(chunk.text);
    if (dynamicTokens + tokens > dynamicBudget) break;
    selectedTexts.push(chunk.text);
    dynamicTokens += tokens;
  }

  if (selectedTexts.length > 0) {
    parts.push(`## Relevant Knowledge\n\n${selectedTexts.map((t) => `- ${t}`).join("\n")}`);
  }

  const markdown = parts.join("\n\n");
  return { markdown, coreTokens, dynamicTokens };
}

export function buildSystemPromptAddition(
  results: QueryResult[],
  budget: number,
): { markdown: string; tokenCount: number } {
  const sorted = [...results].sort((a, b) => b.score - a.score);

  const selectedTexts: string[] = [];
  let totalTokens = 0;

  for (const result of sorted) {
    const text = result.chunk.text;
    const tokens = estimateTokens(text);
    if (totalTokens + tokens > budget) {
      break;
    }
    selectedTexts.push(text);
    totalTokens += tokens;
  }

  if (selectedTexts.length === 0) {
    return { markdown: "", tokenCount: 0 };
  }

  const markdown = `## Relevant Memory\n\n${selectedTexts.map((t) => `- ${t}`).join("\n")}`;
  return { markdown, tokenCount: totalTokens };
}
