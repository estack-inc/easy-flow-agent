import type { QueryResult } from "@easy-flow/pinecone-client";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens } from "./token-estimator.js";

export const DEFAULT_SKIP_PATTERNS = [
  "記憶しないで",
  "覚えなくていい",
  "覚えないで",
  "no memory",
  "skip memory",
  "dont remember",
  "don't remember",
  "skip ingest",
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
export const ASSEMBLE_TIMEOUT_MS = 3000;

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
  const texts = recent
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .filter((t) => t.length > 0);
  return texts.join("\n");
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
