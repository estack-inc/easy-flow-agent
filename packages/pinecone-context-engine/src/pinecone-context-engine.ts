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
import { rerankChunks } from "./reranker.js";
import {
  ASSEMBLE_TIMEOUT_MS,
  buildEnrichedQuery,
  buildQueryWithTruncation,
  buildRagSystemPromptAddition,
  buildSystemPromptAddition,
  DEFAULT_COMPACT_AFTER_DAYS,
  DEFAULT_INGEST_ROLES,
  DEFAULT_MIN_QUERY_TOKENS,
  DEFAULT_MIN_SCORE,
  DEFAULT_RAG_MIN_SCORE,
  DEFAULT_RAG_TOKEN_BUDGET,
  DEFAULT_RAG_TOP_K,
  DEFAULT_SKIP_PATTERNS,
  DEFAULT_TOKEN_BUDGET,
  DEFAULT_TOP_K,
  extractMessageText,
  readAgentsCore,
  readOldTurns,
  resolveMaxQueryTokens,
  withRetry,
} from "./shared.js";
import { estimateTokens } from "./token-estimator.js";
import type { PineconeContextEngineParams } from "./types.js";

// Re-export for backward compatibility
export { buildEnrichedQuery, isQueryThin } from "./shared.js";

const DEFAULT_INFO: ContextEngineInfo = {
  id: "pinecone",
  name: "Pinecone Context Engine",
  version: "1.0.0",
};

export class PineconeContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo;

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
  private readonly ragEnabled: boolean;
  private readonly agentsCorePath?: string;
  private readonly ragTokenBudget: number;
  private readonly ragMinScore: number;
  private readonly ragTopK: number;
  private readonly maxQueryTokens: number;

  constructor(params: PineconeContextEngineParams) {
    this.info = params.info ?? DEFAULT_INFO;
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
    this.ragEnabled = params.ragEnabled ?? false;
    this.agentsCorePath = params.agentsCorePath;
    this.ragTokenBudget = params.ragTokenBudget ?? DEFAULT_RAG_TOKEN_BUDGET;
    this.ragMinScore = params.ragMinScore ?? DEFAULT_RAG_MIN_SCORE;
    this.ragTopK = params.ragTopK ?? DEFAULT_RAG_TOP_K;

    this.maxQueryTokens = resolveMaxQueryTokens(params.maxQueryTokens);
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

      const text = extractMessageText(message.content);

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
    if (this.ragEnabled) {
      return this.assembleRag(params);
    }
    return this.assembleClassic(params);
  }

  private async assembleClassic(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    try {
      const truncation = buildQueryWithTruncation(params.messages, this.maxQueryTokens);

      if (!truncation.query) {
        return {
          messages: params.messages,
          estimatedTokens: 0,
        };
      }

      if (truncation.truncated) {
        console.info(
          `[PineconeContextEngine] query truncated: before=${truncation.originalTokens} after=${truncation.truncatedTokens} turns_used=${truncation.turnsUsed} turns_total=${truncation.turnsTotal}`,
        );
      }

      const queryText = this.capQuery(this.enrichQuery(truncation.query), truncation.query);

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

  private async assembleRag(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    try {
      const startTime = Date.now();

      // 1. AGENTS-CORE.md 読み込みを即座に開始（await せず並列化）
      const agentsCorePromise = this.agentsCorePath
        ? readAgentsCore(this.agentsCorePath)
        : Promise.resolve("");

      // 2. 検索クエリを生成（同期処理）+ truncation
      const truncation = buildQueryWithTruncation(params.messages, this.maxQueryTokens);
      const baseQuery = truncation.query;
      const queryTokens = truncation.truncatedTokens;
      const totalBudget = params.tokenBudget ?? this.ragTokenBudget;

      if (truncation.truncated) {
        console.info(
          `[PineconeContextEngine] query truncated: before=${truncation.originalTokens} after=${truncation.truncatedTokens} turns_used=${truncation.turnsUsed} turns_total=${truncation.turnsTotal}`,
        );
      }

      if (!baseQuery) {
        // クエリなし → AGENTS-CORE.md のみ返却
        const agentsCoreText = await agentsCorePromise;
        if (agentsCoreText) {
          const coreTokens = estimateTokens(agentsCoreText);
          console.info(
            `[PineconeContextEngine] mode=rag query_tokens=0 ns=agent:${this.agentId} topK=0 results=0 latency=${Date.now() - startTime}ms`,
          );
          console.info(
            `[PineconeContextEngine] merged: core_tokens=${coreTokens} dynamic_tokens=0 total=${coreTokens} budget=${totalBudget}`,
          );
          return {
            messages: params.messages,
            estimatedTokens: coreTokens,
            systemPromptAddition: agentsCoreText,
          };
        }
        return { messages: params.messages, estimatedTokens: 0 };
      }

      const queryText = this.capQuery(this.enrichQuery(baseQuery), baseQuery);

      // 3. AGENTS-CORE.md と Pinecone セマンティック検索を並列実行
      const pineconePromise = Promise.race([
        withRetry(() =>
          this.client.query({
            text: queryText,
            agentId: this.agentId,
            topK: this.ragTopK,
            minScore: this.ragMinScore,
          }),
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("assemble timeout")), ASSEMBLE_TIMEOUT_MS),
        ),
      ]);

      let agentsCoreText: string;
      let results: Awaited<ReturnType<IPineconeClient["query"]>>;
      try {
        [agentsCoreText, results] = await Promise.all([agentsCorePromise, pineconePromise]);
      } catch (err) {
        // Pinecone 接続不可 → AGENTS-CORE.md のみで動作
        console.warn("[PineconeContextEngine] Pinecone query failed in RAG mode:", err);
        agentsCoreText = await agentsCorePromise.catch(() => "");
        if (agentsCoreText) {
          const coreTokens = estimateTokens(agentsCoreText);
          return {
            messages: params.messages,
            estimatedTokens: coreTokens,
            systemPromptAddition: agentsCoreText,
          };
        }
        return this.fallback.assemble(params);
      }

      if (this.agentsCorePath && !agentsCoreText) {
        console.warn(`[PineconeContextEngine] AGENTS-CORE.md not found: ${this.agentsCorePath}`);
      }

      const latency = Date.now() - startTime;

      if (results.length === 0) {
        console.info(
          `[PineconeContextEngine] mode=rag query_tokens=${queryTokens} ns=agent:${this.agentId} topK=${this.ragTopK} results=0 latency=${latency}ms`,
        );
        // 検索結果 0 件 → AGENTS-CORE.md のみ
        if (agentsCoreText) {
          const coreTokens = estimateTokens(agentsCoreText);
          console.info(
            `[PineconeContextEngine] merged: core_tokens=${coreTokens} dynamic_tokens=0 total=${coreTokens} budget=${totalBudget}`,
          );
          return {
            messages: params.messages,
            estimatedTokens: coreTokens,
            systemPromptAddition: agentsCoreText,
          };
        }
        return { messages: params.messages, estimatedTokens: 0 };
      }

      // 4. re-ranking
      const chunksForRerank = results.map((r) => ({
        id: r.chunk.id,
        text: r.chunk.text,
        score: r.score,
        metadata: r.chunk.metadata,
      }));
      const ranked = rerankChunks(chunksForRerank);
      const deduplicated = chunksForRerank.length - ranked.length;

      // rerank ログ: sourceType 別カウント
      const typeCounts: Record<string, number> = {};
      for (const chunk of ranked) {
        const st = chunk.metadata.sourceType;
        typeCounts[st] = (typeCounts[st] ?? 0) + 1;
      }
      console.info(
        `[PineconeContextEngine] mode=rag query_tokens=${queryTokens} ns=agent:${this.agentId} topK=${this.ragTopK} results=${results.length} latency=${latency}ms`,
      );
      console.info(
        `[PineconeContextEngine] rerank: ${Object.entries(typeCounts)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")} deduplicated=${deduplicated}`,
      );

      // 5. トークン予算内でマージ
      // totalBudget は総トークン上限。AGENTS-CORE.md 分を差し引いて動的チャンク予算を算出
      const coreTokensEstimate = agentsCoreText ? estimateTokens(agentsCoreText) : 0;
      const dynamicBudget = Math.max(0, totalBudget - coreTokensEstimate);
      const { markdown, coreTokens, dynamicTokens } = buildRagSystemPromptAddition(
        agentsCoreText,
        ranked,
        dynamicBudget,
        coreTokensEstimate,
      );
      const totalTokens = coreTokens + dynamicTokens;

      console.info(
        `[PineconeContextEngine] merged: core_tokens=${coreTokens} dynamic_tokens=${dynamicTokens} total=${totalTokens} budget=${totalBudget}`,
      );

      return {
        messages: params.messages,
        estimatedTokens: totalTokens,
        systemPromptAddition: markdown || undefined,
      };
    } catch (err) {
      console.error("[PineconeContextEngine] assembleRag failed, using fallback:", err);
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
        const text = extractMessageText(msg.content);

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

  /**
   * Ensure the final query text (including memoryHint) does not exceed maxQueryTokens.
   * If it does, fall back to the base query without memoryHint enrichment.
   */
  private capQuery(enrichedQuery: string, baseQuery: string): string {
    if (this.maxQueryTokens <= 0) return enrichedQuery;
    if (estimateTokens(enrichedQuery) <= this.maxQueryTokens) return enrichedQuery;
    return baseQuery;
  }
}
