import { createHash } from "node:crypto";
import type { IPineconeClient, QueryResult } from "@easy-flow/pinecone-client";
import { TextChunker } from "@easy-flow/pinecone-client";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  AssembleResult,
  BootstrapResult,
  CompactResult,
  ContextEngine,
  ContextEngineInfo,
  IngestResult,
} from "openclaw/plugin-sdk";
import { EmptyFallbackContextEngine, FallbackContextEngine } from "./fallback-adapter.js";
import { estimateTokens } from "./token-estimator.js";
import type { PineconeContextEngineParams } from "./types.js";

// Re-use existing constants
const DEFAULT_SKIP_PATTERNS = [
  "記憶しないで",
  "覚えなくていい",
  "覚えないで",
  "no memory",
  "skip memory",
  "dont remember",
  "don't remember",
  "skip ingest",
];

const RECENT_TURNS_FOR_QUERY = 3;
const DEFAULT_TOP_K = 20;
const DEFAULT_MIN_SCORE = 0.7;
const DEFAULT_TOKEN_BUDGET = 16000;
const DEFAULT_MIN_QUERY_TOKENS = 20;
const DEFAULT_INGEST_ROLES: ("user" | "assistant")[] = ["user", "assistant"];
const DEFAULT_COMPACT_AFTER_DAYS = 7;
const RETRY_BASE_MS = 100;
const MAX_RETRIES = 3;
const ASSEMBLE_TIMEOUT_MS = 3000;

// Import utility functions from original file
export function isQueryThin(query: string, minTokens: number = DEFAULT_MIN_QUERY_TOKENS): boolean {
  const tokens = estimateTokens(query);
  const hasProperNoun = /[A-Z\u4E00-\u9FFF\u30A0-\u30FF]/.test(query);
  return tokens < minTokens || !hasProperNoun;
}

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

function isRateLimitError(err: unknown): boolean {
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

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  const maxAttempts = MAX_RETRIES + 1;
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

/**
 * ParallelAssembleResult extends standard AssembleResult with lazy context loading
 */
interface ParallelAssembleResult extends AssembleResult {
  contextPromise?: Promise<{
    systemPromptAddition?: string;
    estimatedTokens: number;
  }>;
}

export class PineconeContextEngineParallel implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "pinecone-parallel",
    name: "Pinecone Context Engine (Parallel)",
    version: "1.0.0-parallel",
  };

  private readonly client: IPineconeClient;
  private readonly agentId: string;
  private readonly tokenBudget: number;
  private readonly ingestRoles: ("user" | "assistant")[];
  private readonly fallback: ContextEngine;
  private readonly memoryHint?: string;
  private readonly minQueryTokens: number;

  constructor(params: PineconeContextEngineParams) {
    this.client = params.pineconeClient;
    this.agentId = params.agentId;
    this.tokenBudget = params.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    this.ingestRoles = params.ingestRoles ?? DEFAULT_INGEST_ROLES;
    this.fallback = params.fallbackAdapter
      ? new FallbackContextEngine(params.fallbackAdapter)
      : new EmptyFallbackContextEngine();
    this.memoryHint = params.memoryHint;
    this.minQueryTokens = params.minQueryTokens ?? DEFAULT_MIN_QUERY_TOKENS;
  }

  async bootstrap(params: { sessionId: string; sessionFile: string }): Promise<BootstrapResult> {
    try {
      await withRetry(() => this.client.ensureIndex());
      return { bootstrapped: true };
    } catch (err) {
      console.error("[PineconeContextEngineParallel] bootstrap failed:", err);
      return {
        bootstrapped: false,
        reason: `bootstrap failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async ingest(params: {
    sessionId: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    try {
      const { message, sessionId } = params;

      if (!this.ingestRoles.includes(message.role as "user" | "assistant")) {
        return { ingested: false };
      }

      const text =
        typeof message.content === "string" ? message.content : JSON.stringify(message.content);

      if (!text || text.length === 0) {
        return { ingested: false };
      }

      // Skip messages containing skip patterns
      const lowerText = text.toLowerCase();
      const shouldSkip = DEFAULT_SKIP_PATTERNS.some((pattern) =>
        lowerText.includes(pattern.toLowerCase()),
      );
      if (shouldSkip) {
        return { ingested: false };
      }

      const contentHash = createHash("sha256")
        .update(`${sessionId}:${message.role}:${text}`)
        .digest("hex")
        .slice(0, 16);
      const turnId = `${sessionId}:${contentHash}`;
      const chunker = new TextChunker();
      const chunks = chunker.chunk({
        text,
        agentId: this.agentId,
        sourceFile: `session:${sessionId}:${contentHash}`,
        sourceType: "session_turn",
        turnId,
        role: message.role as "user" | "assistant",
        category: "conversation",
      });

      if (chunks.length === 0) {
        return { ingested: false };
      }

      await withRetry(() => this.client.upsert(chunks));
      return { ingested: true };
    } catch (err) {
      console.error("[PineconeContextEngineParallel] ingest failed:", err);
      return { ingested: false };
    }
  }

  /**
   * PARALLEL IMPLEMENTATION: Start Pinecone query immediately, return Promise for lazy loading
   */
  async assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<ParallelAssembleResult> {
    const baseQuery = this.buildQueryFromRecentTurns(params.messages);

    if (!baseQuery) {
      return {
        messages: params.messages,
        estimatedTokens: 0,
      };
    }

    const queryText = buildEnrichedQuery(baseQuery, this.memoryHint, this.minQueryTokens);
    const budget = params.tokenBudget ?? this.tokenBudget;

    // START PINECONE QUERY IMMEDIATELY - DO NOT AWAIT
    const contextPromise = Promise.race([
      withRetry(() =>
        this.client.query({
          text: queryText,
          agentId: this.agentId,
          topK: DEFAULT_TOP_K,
          minScore: DEFAULT_MIN_SCORE,
        }),
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("assemble timeout")), ASSEMBLE_TIMEOUT_MS),
      ),
    ])
      .then((results: QueryResult[]) => {
        if (results.length === 0) {
          return {
            systemPromptAddition: undefined,
            estimatedTokens: 0,
          };
        }
        const { markdown, tokenCount } = this.buildSystemPromptAddition(results, budget);
        return {
          systemPromptAddition: markdown || undefined,
          estimatedTokens: tokenCount,
        };
      })
      .catch((err) => {
        console.error("[PineconeContextEngineParallel] assemble failed, using fallback:", err);
        // Return fallback context when error occurs
        return {
          systemPromptAddition: undefined,
          estimatedTokens: 0,
        };
      });

    // RETURN IMMEDIATELY WITH PROMISE - OpenClaw can start LLM request in parallel
    return {
      messages: params.messages,
      estimatedTokens: 0, // Will be updated when contextPromise resolves
      contextPromise,
    };
  }

  async compact(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: Record<string, unknown>;
  }): Promise<CompactResult> {
    // For now, delegate to fallback for compact operations
    return this.fallback.compact(params);
  }

  async dispose(): Promise<void> {
    // No resources to release
  }

  // Copy all private/utility methods from original implementation
  private buildQueryFromRecentTurns(messages: AgentMessage[]): string {
    const recent = messages.slice(-RECENT_TURNS_FOR_QUERY);
    const texts = recent
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .filter((t) => t.length > 0);
    return texts.join("\n");
  }

  private buildSystemPromptAddition(
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
}