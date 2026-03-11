import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  CompactResult,
  IngestResult,
} from "openclaw/plugin-sdk";

/**
 * Minimal no-op ContextEngine delegate.
 *
 * Used as a fallback when the real LegacyContextEngine hasn't been
 * resolved yet (e.g., tool factory runs before context engine init).
 * All methods pass through without modification.
 */
export function createNoopDelegate(): ContextEngine {
  return {
    info: {
      id: "noop",
      name: "No-op Delegate",
      version: "0.0.0",
    } satisfies ContextEngineInfo,

    async ingest(): Promise<IngestResult> {
      return { ingested: false };
    },

    async assemble(params: {
      sessionId: string;
      messages: AgentMessage[];
      tokenBudget?: number;
    }): Promise<AssembleResult> {
      return { messages: params.messages, estimatedTokens: 0 };
    },

    async compact(): Promise<CompactResult> {
      return { ok: true, compacted: false, reason: "noop delegate" };
    },
  };
}
