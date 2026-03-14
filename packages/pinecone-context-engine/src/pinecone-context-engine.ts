import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  CompactResult,
  IngestResult,
  BootstrapResult,
} from "openclaw/plugin-sdk";
import { TextChunker } from "@easy-flow/pinecone-client";
import type { IPineconeClient, QueryResult } from "@easy-flow/pinecone-client";
import type { PineconeContextEngineParams } from "./types.js";
import { estimateTokens } from "./token-estimator.js";
import {
  FallbackContextEngine,
  EmptyFallbackContextEngine,
} from "./fallback-adapter.js";

const RECENT_TURNS_FOR_QUERY = 3;
const DEFAULT_TOP_K = 20;
const DEFAULT_MIN_SCORE = 0.7;
const DEFAULT_TOKEN_BUDGET = 8000;
const DEFAULT_INGEST_ROLES: ("user" | "assistant")[] = ["user", "assistant"];
const DEFAULT_COMPACT_AFTER_DAYS = 7;

const RETRY_BASE_MS = 100;
const MAX_RETRIES = 3;

function isRateLimitError(err: unknown): boolean {
  if (err && typeof err === "object") {
    if ("status" in err && (err as { status: number }).status === 429)
      return true;
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
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRateLimitError(err) || attempt === MAX_RETRIES - 1) {
        throw err;
      }
      const delay = RETRY_BASE_MS * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

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
  private readonly hasFallbackAdapter: boolean;
  private readonly chunker: TextChunker;

  constructor(params: PineconeContextEngineParams) {
    this.client = params.pineconeClient;
    this.agentId = params.agentId;
    this.tokenBudget = params.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    this.ingestRoles = params.ingestRoles ?? DEFAULT_INGEST_ROLES;
    this.compactAfterDays = params.compactAfterDays ?? DEFAULT_COMPACT_AFTER_DAYS;
    this.hasFallbackAdapter = params.fallbackAdapter !== undefined;
    this.fallback = params.fallbackAdapter
      ? new FallbackContextEngine(params.fallbackAdapter)
      : new EmptyFallbackContextEngine();
    this.chunker = new TextChunker();
  }

  async bootstrap(params: {
    sessionId: string;
    sessionFile: string;
  }): Promise<BootstrapResult> {
    await withRetry(() => this.client.ensureIndex());
    return { bootstrapped: true };
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
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content);

      if (!text || text.length === 0) {
        return { ingested: false };
      }

      const turnId = `${sessionId}:${Date.now()}`;
      const chunks = this.chunker.chunk({
        text,
        agentId: this.agentId,
        sourceFile: `session:${sessionId}`,
        sourceType: "session_turn",
        turnId,
        role: message.role as "user" | "assistant",
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
      const queryText = this.buildQueryFromRecentTurns(params.messages);

      if (!queryText) {
        return {
          messages: params.messages,
          estimatedTokens: 0,
        };
      }

      const results = await withRetry(() =>
        this.client.query({
          text: queryText,
          agentId: this.agentId,
          topK: DEFAULT_TOP_K,
          minScore: DEFAULT_MIN_SCORE,
        }),
      );

      if (results.length === 0) {
        return {
          messages: params.messages,
          estimatedTokens: 0,
        };
      }

      const budget = params.tokenBudget ?? this.tokenBudget;
      const { markdown, tokenCount } = this.buildSystemPromptAddition(
        results,
        budget,
      );

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

      const cutoff =
        Date.now() - this.compactAfterDays * 24 * 60 * 60 * 1000;

      const oldMessages = await this.readOldTurns(sessionFile, cutoff);

      if (oldMessages.length === 0) {
        return { ok: true, compacted: false, reason: "no old turns to compact" };
      }

      // Upsert all old turns to Pinecone (idempotent)
      const allChunks = oldMessages.flatMap((msg, idx) => {
        const text =
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content);

        return this.chunker.chunk({
          text,
          agentId: this.agentId,
          sourceFile: `session:${sessionId}`,
          sourceType: "session_turn",
          turnId: `${sessionId}:compact:${idx}`,
          role: msg.role as "user" | "assistant",
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

  private buildQueryFromRecentTurns(messages: AgentMessage[]): string {
    const recent = messages.slice(-RECENT_TURNS_FOR_QUERY);
    const texts = recent
      .map((m) =>
        typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      )
      .filter((t) => t.length > 0);
    return texts.join("\n");
  }

  private buildSystemPromptAddition(
    results: QueryResult[],
    budget: number,
  ): { markdown: string; tokenCount: number } {
    // Sort by score descending
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

    const markdown =
      "## Relevant Memory\n\n" +
      selectedTexts.map((t) => `- ${t}`).join("\n");

    return { markdown, tokenCount: totalTokens };
  }

  private async readOldTurns(
    sessionFile: string,
    cutoffTimestamp: number,
  ): Promise<AgentMessage[]> {
    try {
      const fs = await import("node:fs");
      const content = fs.readFileSync(sessionFile, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);

      const oldMessages: AgentMessage[] = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          // Session entries have a timestamp field
          if (entry.timestamp && entry.timestamp < cutoffTimestamp && entry.message) {
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
}
