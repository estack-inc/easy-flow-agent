import * as fs from "node:fs";
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

const OPENCLAW_CONFIG_PATH = "/data/openclaw.json";

/**
 * Fallback: read plugin config directly from openclaw.json when api.pluginConfig is empty.
 *
 * Auto-discovered extensions (loaded from /data/extensions/) may not receive config
 * via api.pluginConfig due to entrypoint clearing plugins.load.paths.
 * See: estack-inc/easy-flow#189
 */
function readConfigFallback(
  configPath: string,
  logger: Pick<OpenClawPluginApi["logger"], "debug">,
): Partial<PluginConfig> {
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const config = JSON.parse(raw);
    return (config?.plugins?.entries?.["pgvector-memory"]?.config ?? {}) as Partial<PluginConfig>;
  } catch (err) {
    logger.debug(`readConfigFallback failed: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

export default function register(api: OpenClawPluginApi): void {
  let cfg = (api.pluginConfig ?? {}) as PluginConfig;

  if (Object.keys(cfg).length === 0) {
    cfg = readConfigFallback(OPENCLAW_CONFIG_PATH, api.logger) as PluginConfig;
  }

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
