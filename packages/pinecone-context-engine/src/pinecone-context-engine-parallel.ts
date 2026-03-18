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

/**
 * ParallelAssembleResult extends standard AssembleResult with lazy context loading.
 *
 * NOTE: `contextPromise` is a custom extension field not part of the OpenClaw
 * `AssembleResult` interface. The OpenClaw runtime will NOT consume this field
 * unless explicitly updated to support it. Until then, `systemPromptAddition`
 * will not be injected into the LLM prompt via this parallel path.
 * This implementation is prepared for OpenClaw SDK integration (Phase 2).
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
  private readonly compactAfterDays: number;
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
      console.error("[PineconeContextEngineParallel] ingest failed:", err);
      return { ingested: false };
    }
  }

  /**
   * PARALLEL IMPLEMENTATION: Start Pinecone query immediately, return Promise for lazy loading.
   */
  async assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<ParallelAssembleResult> {
    const baseQuery = buildQueryFromRecentTurns(params.messages);

    if (!baseQuery) {
      return {
        messages: params.messages,
        estimatedTokens: 0,
      };
    }

    const queryText = buildEnrichedQuery(baseQuery, this.memoryHint, this.minQueryTokens);
    const budget = params.tokenBudget ?? this.tokenBudget;

    // START PINECONE QUERY IMMEDIATELY - DO NOT AWAIT
    let timeoutHandle!: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error("assemble timeout")), ASSEMBLE_TIMEOUT_MS);
    });

    const contextPromise = Promise.race([
      withRetry(() =>
        this.client.query({
          text: queryText,
          agentId: this.agentId,
          topK: DEFAULT_TOP_K,
          minScore: DEFAULT_MIN_SCORE,
        }),
      ),
      timeoutPromise,
    ])
      .then((results: QueryResult[]) => {
        clearTimeout(timeoutHandle);
        if (results.length === 0) {
          return {
            systemPromptAddition: undefined,
            estimatedTokens: 0,
          };
        }
        const { markdown, tokenCount } = buildSystemPromptAddition(results, budget);
        return {
          systemPromptAddition: markdown || undefined,
          estimatedTokens: tokenCount,
        };
      })
      .catch((err) => {
        clearTimeout(timeoutHandle);
        console.error("[PineconeContextEngineParallel] assemble failed, using fallback:", err);
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
    try {
      const { sessionId, sessionFile } = params;

      const cutoff = Date.now() - this.compactAfterDays * 24 * 60 * 60 * 1000;

      const oldMessages = await readOldTurns(sessionFile, cutoff);

      if (oldMessages.length === 0) {
        return { ok: true, compacted: false, reason: "no old turns to compact" };
      }

      // Upsert all old turns to Pinecone (idempotent)
      const allChunks = oldMessages.flatMap((msg) => {
        const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);

        if (!text || text.length === 0) {
          return [];
        }

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

      return { ok: true, compacted: true };
    } catch (err) {
      console.error("[PineconeContextEngineParallel] compact failed:", err);
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
}
