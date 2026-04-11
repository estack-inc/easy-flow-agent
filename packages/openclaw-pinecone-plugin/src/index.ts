import { PineconeClient } from "@easy-flow/pinecone-client";
import { PineconeContextEngine } from "@easy-flow/pinecone-context-engine";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

type PluginConfig = {
  apiKey?: string;
  agentId?: string;
  indexName?: string;
  compactAfterDays?: number;
  memoryHint?: string;
  minQueryTokens?: number;
  ragEnabled?: boolean;
  agentsCorePath?: string;
  ragTokenBudget?: number;
  ragMinScore?: number;
  ragTopK?: number;
};

export default function register(api: OpenClawPluginApi): void {
  const cfg = (api.pluginConfig ?? {}) as PluginConfig;

  const apiKey = cfg.apiKey ?? process.env.PINECONE_API_KEY;
  if (!apiKey) {
    api.logger.warn("pinecone-memory: PINECONE_API_KEY not set — plugin disabled");
    return;
  }

  const agentId = cfg.agentId ?? process.env.OPENCLAW_AGENT_ID ?? "default";
  const indexName = cfg.indexName ?? "easy-flow-memory";
  const compactAfterDays = cfg.compactAfterDays ?? 7;

  const ragEnabled = cfg.ragEnabled ?? process.env.RAG_ENABLED === "true";
  const agentsCorePath = cfg.agentsCorePath ?? process.env.RAG_AGENTS_CORE_PATH;
  const ragTokenBudget =
    cfg.ragTokenBudget ??
    (process.env.RAG_TOKEN_BUDGET ? Number(process.env.RAG_TOKEN_BUDGET) : undefined);
  const ragMinScore =
    cfg.ragMinScore ?? (process.env.RAG_MIN_SCORE ? Number(process.env.RAG_MIN_SCORE) : undefined);
  const ragTopK =
    cfg.ragTopK ?? (process.env.RAG_TOP_K ? Number(process.env.RAG_TOP_K) : undefined);

  api.registerContextEngine("pinecone-memory", () => {
    const client = new PineconeClient({ apiKey, indexName });
    return new PineconeContextEngine({
      pineconeClient: client,
      agentId,
      compactAfterDays,
      memoryHint: cfg.memoryHint,
      minQueryTokens: cfg.minQueryTokens,
      ragEnabled,
      agentsCorePath,
      ragTokenBudget,
      ragMinScore,
      ragTopK,
    });
  });

  const mode = ragEnabled ? "rag" : "classic";
  api.logger.info(
    `pinecone-memory: registered (agentId: ${agentId}, index: ${indexName}, mode: ${mode})`,
  );
}
