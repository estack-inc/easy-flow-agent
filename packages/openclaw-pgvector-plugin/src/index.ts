import { PgVectorClient } from "@easy-flow/pgvector-client";
import { PineconeContextEngine } from "@easy-flow/pinecone-context-engine";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

type PluginConfig = {
  databaseUrl?: string;
  geminiApiKey?: string;
  agentId?: string;
  compactAfterDays?: number;
  memoryHint?: string;
  minQueryTokens?: number;
};

export default function register(api: OpenClawPluginApi): void {
  const cfg = (api.pluginConfig ?? {}) as PluginConfig;

  const databaseUrl = cfg.databaseUrl ?? process.env.PGVECTOR_DATABASE_URL;
  const geminiApiKey = cfg.geminiApiKey ?? process.env.GEMINI_API_KEY;

  if (!databaseUrl || !geminiApiKey) {
    api.logger.warn(
      "pgvector-memory: PGVECTOR_DATABASE_URL / GEMINI_API_KEY not set — plugin disabled",
    );
    return;
  }

  const agentId = cfg.agentId ?? process.env.OPENCLAW_AGENT_ID ?? "default";
  const compactAfterDays = cfg.compactAfterDays ?? 7;

  api.registerContextEngine("pgvector-memory", () => {
    const client = new PgVectorClient({ databaseUrl, geminiApiKey });
    return new PineconeContextEngine({
      pineconeClient: client,
      agentId,
      compactAfterDays,
      memoryHint: cfg.memoryHint,
      minQueryTokens: cfg.minQueryTokens,
    });
  });

  api.logger.info(
    `pgvector-memory: registered (agentId: ${agentId}, compactAfterDays: ${compactAfterDays})`,
  );
}
