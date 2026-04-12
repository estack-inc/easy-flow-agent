import { PineconeContextEngine } from "@easy-flow/pinecone-context-engine";
import { UpstashVectorClient } from "@easy-flow/upstash-vector-client";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

type PluginConfig = {
  url?: string;
  token?: string;
  agentId?: string;
  compactAfterDays?: number;
  memoryHint?: string;
  minQueryTokens?: number;
};

export default function register(api: OpenClawPluginApi): void {
  const cfg = (api.pluginConfig ?? {}) as PluginConfig;

  const url = cfg.url ?? process.env.UPSTASH_VECTOR_REST_URL;
  const token = cfg.token ?? process.env.UPSTASH_VECTOR_REST_TOKEN;

  if (!url || !token) {
    api.logger.warn(
      "upstash-memory: UPSTASH_VECTOR_REST_URL / UPSTASH_VECTOR_REST_TOKEN not set — plugin disabled",
    );
    return;
  }

  const agentId = cfg.agentId ?? process.env.OPENCLAW_AGENT_ID ?? "default";
  const compactAfterDays = cfg.compactAfterDays ?? 7;

  api.registerContextEngine("upstash-memory", () => {
    const client = new UpstashVectorClient({ url, token });
    return new PineconeContextEngine({
      pineconeClient: client,
      agentId,
      compactAfterDays,
      memoryHint: cfg.memoryHint,
      minQueryTokens: cfg.minQueryTokens,
    });
  });

  api.logger.info(
    `upstash-memory: registered (agentId: ${agentId}, compactAfterDays: ${compactAfterDays})`,
  );
}
