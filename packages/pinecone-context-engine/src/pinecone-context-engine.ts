import { createHash } from "node:crypto";
import type { IPineconeClient } from "@easy-flow/pinecone-client";
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
import {
  ASSEMBLE_TIMEOUT_MS,
  buildEnrichedQuery,
  buildQueryFromRecentTurns,
  buildSystemPromptAddition,
  DEFAULT_COMPACT_AFTER_DAYS,
  DEFAULT_INGEST_ROLES,
  DEFAULT_MIN_QUERY_TOKENS,
  DEFAULT_MIN_SCORE,
  DEFAULT_SKIP_PATTERNS,
  DEFAULT_TOKEN_BUDGET,
  DEFAULT_TOP_K,
  readOldTurns,
  withRetry,
} from "./shared.js";
import type { PineconeContextEngineParams } from "./types.js";

// Re-export for backward compatibility
export { buildEnrichedQuery, isQueryThin } from "./shared.js";

export class PineconeContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "pinecone",
    name: "Pinecone Context Engine",
    version: "1.0.0",
  };

  private readonly client: IPineconeClient;
  private readonly agentId: string;
  private readonly tokenBudget: number;
  private readonly ingestRoles: ("user" | "assistant")[];
  private readonly compactAfterDays: number;
  private readonly fallback: ContextEngine;
  private readonly chunker: TextChunker;
  private readonly skipPatterns: string[];
  private readonly defaultCategory: string;
  private readonly memoryHint?: string;
  private readonly minQueryTokens: number;

  constructor(params: PineconeContextEngineParams) {
    this.client = params.pineconeClient;
    this.agentId = params.agentId;
    this.tokenBudget = params.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    this.ingestRoles = params.ingestRoles ?? DEFAULT_INGEST_ROLES;
    this.compactAfterDays = params.compactAfterDays ?? DEFAULT_COMPACT_AFTER_DAYS;
    this.fallback = params.fallbackAdapter
      ? new FallbackContextEngine(params.fallbackAdapter)
      : new EmptyFallbackContextEngine();
    this.chunker = new TextChunker();
    this.skipPatterns = params.skipPatterns ?? DEFAULT_SKIP_PATTERNS;
    this.defaultCategory = params.defaultCategory ?? "conversation";
    this.memoryHint = params.memoryHint;
    this.minQueryTokens = params.minQueryTokens ?? DEFAULT_MIN_QUERY_TOKENS;
  }

  async bootstrap(_params: { sessionId: string; sessionFile: string }): Promise<BootstrapResult> {
    try {
      await withRetry(() => this.client.ensureIndex());
      return { bootstrapped: true };
    } catch (err) {
      console.error("[PineconeContextEngine] bootstrap failed:", err);
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
      const shouldSkip = this.skipPatterns.some((pattern) =>
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
      const chunks = this.chunker.chunk({
        text,
        agentId: this.agentId,
        sourceFile: `session:${sessionId}:${contentHash}`,
        sourceType: "session_turn",
        turnId,
        role: message.role as "user" | "assistant",
        category: this.defaultCategory,
      });

      if (chunks.length === 0) {
        return { ingested: false };
      }

      await withRetry(() => this.client.upsert(chunks));

      return { ingested: true };
    } catch (err) {
      console.error("[PineconeContextEngine] ingest failed:", err);
      return { ingested: false };
    }
  }

  async assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    try {
      const baseQuery = buildQueryFromRecentTurns(params.messages);

      if (!baseQuery) {
        return {
          messages: params.messages,
          estimatedTokens: 0,
        };
      }

      const queryText = this.enrichQuery(baseQuery);

      const results = await Promise.race([
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
      ]);

      if (results.length === 0) {
        return {
          messages: params.messages,
          estimatedTokens: 0,
        };
      }

      const budget = params.tokenBudget ?? this.tokenBudget;
      const { markdown, tokenCount } = buildSystemPromptAddition(results, budget);

      return {
        messages: params.messages,
        estimatedTokens: tokenCount,
        systemPromptAddition: markdown || undefined,
      };
    } catch (err) {
      console.error("[PineconeContextEngine] assemble failed, using fallback:", err);
      return this.fallback.assemble(params);
    }
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
    try {
      const { sessionId, sessionFile } = params;

      const cutoff = Date.now() - this.compactAfterDays * 24 * 60 * 60 * 1000;

      const oldMessages = await readOldTurns(sessionFile, cutoff);

      if (oldMessages.length === 0) {
        return { ok: true, compacted: false, reason: "no old turns to compact" };
      }

      // Upsert all old turns to Pinecone (idempotent)
      // Use content hash (same as ingest()) to avoid duplicate entries
      const allChunks = oldMessages.flatMap((msg) => {
        const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);

        if (!text || text.length === 0) {
          return [];
        }

        // Skip messages containing skip patterns (same logic as ingest())
        const lowerText = text.toLowerCase();
        if (this.skipPatterns.some((p) => lowerText.includes(p.toLowerCase()))) {
          return [];
        }

        const contentHash = createHash("sha256")
          .update(`${sessionId}:${msg.role}:${text}`)
          .digest("hex")
          .slice(0, 16);

        return this.chunker.chunk({
          text,
          agentId: this.agentId,
          sourceFile: `session:${sessionId}:${contentHash}`,
          sourceType: "session_turn",
          turnId: `${sessionId}:${contentHash}`,
          role: msg.role as "user" | "assistant",
          category: this.defaultCategory,
        });
      });

      if (allChunks.length > 0) {
        await withRetry(() => this.client.upsert(allChunks));
      }

      // All upserts succeeded — signal OpenClaw runtime to delete old turns
      return { ok: true, compacted: true };
    } catch (err) {
      // Upsert failed — do NOT delete session file turns
      console.error("[PineconeContextEngine] compact failed:", err);
      return {
        ok: false,
        compacted: false,
        reason: `compact failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async dispose(): Promise<void> {
    // No resources to release
  }

  private enrichQuery(baseQuery: string): string {
    return buildEnrichedQuery(baseQuery, this.memoryHint, this.minQueryTokens);
  }
}
