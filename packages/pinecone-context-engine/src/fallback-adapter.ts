import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  CompactResult,
  IngestResult,
  BootstrapResult,
} from "openclaw/plugin-sdk";

/**
 * Wraps an existing ContextEngine as a fallback adapter.
 * Used when Pinecone is unavailable — delegates all calls to the wrapped engine.
 */
export class FallbackContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo;
  private readonly wrapped: ContextEngine;

  constructor(wrapped: ContextEngine) {
    this.wrapped = wrapped;
    this.info = wrapped.info;
  }

  async bootstrap(params: {
    sessionId: string;
    sessionFile: string;
  }): Promise<BootstrapResult> {
    if (this.wrapped.bootstrap) {
      return this.wrapped.bootstrap(params);
    }
    return { bootstrapped: false, reason: "fallback has no bootstrap" };
  }

  async ingest(params: {
    sessionId: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    return this.wrapped.ingest(params);
  }

  async assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    return this.wrapped.assemble(params);
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
    return this.wrapped.compact(params);
  }

  async dispose(): Promise<void> {
    if (this.wrapped.dispose) {
      await this.wrapped.dispose();
    }
  }
}

/**
 * Empty fallback — returns neutral results without any external calls.
 * Used when no fallbackAdapter is configured.
 */
export class EmptyFallbackContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "empty-fallback",
    name: "Empty Fallback Context Engine",
    version: "1.0.0",
  };

  async ingest(): Promise<IngestResult> {
    return { ingested: false };
  }

  async assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    return { messages: params.messages, estimatedTokens: 0 };
  }

  async compact(): Promise<CompactResult> {
    return { ok: true, compacted: false, reason: "empty fallback" };
  }
}
