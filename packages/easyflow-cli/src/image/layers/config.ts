import type { Agentfile } from "../../agentfile/types.js";
import { type PackEntry, packLayer } from "../tar-pack.js";
import type { LayerData } from "../types.js";

/**
 * config レイヤー（openclaw.json / channels.json / Agentfile）を生成する。
 *
 * - openclaw.json: `{ model, rag, env }` の最小スキーマ（Phase 1）
 * - channels.json: Agentfile の channels セクションをそのまま保存
 * - Agentfile: 元 YAML テキストを再現用に保存
 * - Agentfile.resolved.json: base 継承を解決したビルド時点の Agentfile（シークレット env キーはマスク済み）
 */

// Fly イメージに焼き込む Agentfile から除外するシークレット env キー
const SECRET_ENV_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "PINECONE_API_KEY",
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
  "LINE_ACCESS_TOKEN",
  "LINE_CHANNEL_SECRET",
  "GATEWAY_TOKEN",
]);

function sanitizeAgentfileEnv(agentfile: Agentfile): Agentfile {
  if (!agentfile.config?.env) return agentfile;
  const sanitizedEnv = Object.fromEntries(
    Object.entries(agentfile.config.env).filter(([key]) => !SECRET_ENV_KEYS.has(key)),
  );
  return {
    ...agentfile,
    config: {
      ...agentfile.config,
      env: sanitizedEnv,
    },
  };
}

export async function buildConfigLayer(
  agentfile: Agentfile,
  agentfileRawContent: string,
): Promise<LayerData> {
  const openclawConfig = {
    model: agentfile.config?.model ?? {},
    rag: agentfile.config?.rag ?? { enabled: false },
    env: agentfile.config?.env ?? {},
  };

  const channels = agentfile.channels ?? {};

  const entries: PackEntry[] = [
    {
      kind: "file",
      name: "openclaw.json",
      content: `${JSON.stringify(openclawConfig, null, 2)}\n`,
    },
    {
      kind: "file",
      name: "channels.json",
      content: `${JSON.stringify(channels, null, 2)}\n`,
    },
    {
      kind: "file",
      name: "Agentfile",
      content: agentfileRawContent,
    },
    {
      kind: "file",
      name: "Agentfile.resolved.json",
      content: `${JSON.stringify(sanitizeAgentfileEnv(agentfile), null, 2)}\n`,
    },
  ];

  return packLayer(entries);
}
