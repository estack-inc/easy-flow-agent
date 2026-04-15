import * as fs from "node:fs";
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
  maxQueryTokens?: number;
  ragEnabled?: boolean;
  agentsCorePath?: string;
  ragTokenBudget?: number;
  ragMinScore?: number;
  ragTopK?: number;
};

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
    return (config?.plugins?.entries?.["pinecone-memory"]?.config ?? {}) as Partial<PluginConfig>;
  } catch (err) {
    logger.debug(`readConfigFallback failed: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

function parseFiniteNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  const n = parseFiniteNumber(value);
  if (n === undefined) return undefined;
  const rounded = Math.round(n);
  return rounded >= 1 ? rounded : undefined;
}

function parseScoreFloat(value: string | undefined): number | undefined {
  const n = parseFiniteNumber(value);
  if (n === undefined) return undefined;
  return n >= 0 && n <= 1 ? n : undefined;
}

const OPENCLAW_CONFIG_PATH = "/data/openclaw.json";

export default function register(api: OpenClawPluginApi): void {
  const apiCfg = (api.pluginConfig ?? {}) as PluginConfig;
  const hasApiConfig = Object.keys(apiCfg).length > 0;
  let cfg: PluginConfig;
  if (hasApiConfig) {
    cfg = apiCfg;
  } else {
    const fallback = readConfigFallback(OPENCLAW_CONFIG_PATH, api.logger);
    const hasFallback = Object.keys(fallback).length > 0;
    cfg = { ...fallback };
    if (hasFallback) {
      api.logger.info("pinecone-memory: api.pluginConfig empty — loaded config from openclaw.json");
    } else {
      api.logger.warn(
        "pinecone-memory: api.pluginConfig empty and openclaw.json fallback returned no config",
      );
    }
  }

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
  const ragTokenBudget = cfg.ragTokenBudget ?? parsePositiveInt(process.env.RAG_TOKEN_BUDGET);
  const ragMinScore = cfg.ragMinScore ?? parseScoreFloat(process.env.RAG_MIN_SCORE);
  const ragTopK = cfg.ragTopK ?? parsePositiveInt(process.env.RAG_TOP_K);

  api.registerContextEngine("pinecone-memory", () => {
    const client = new PineconeClient({ apiKey, indexName });
    return new PineconeContextEngine({
      pineconeClient: client,
      agentId,
      compactAfterDays,
      memoryHint: cfg.memoryHint,
      minQueryTokens: cfg.minQueryTokens,
      maxQueryTokens: cfg.maxQueryTokens,
      ragEnabled,
      agentsCorePath,
      ragTokenBudget,
      ragMinScore,
      ragTopK,
    });
  });

  const mode = ragEnabled ? "rag" : "classic";
  api.logger.info(
    `pinecone-memory: registered (agentId: ${agentId}, index: ${indexName}, mode: ${mode}, compactAfterDays: ${compactAfterDays})`,
  );
}
