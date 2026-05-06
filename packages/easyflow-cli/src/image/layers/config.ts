import type { Agentfile } from "../../agentfile/types.js";
import { type PackEntry, packLayer } from "../tar-pack.js";
import type { LayerData } from "../types.js";

/**
 * config レイヤー（openclaw.json / channels.json / Agentfile.resolved.json）を生成する。
 *
 * - openclaw.json: `{ model, rag, env }` の最小スキーマ（Phase 1）。シークレット env キーは除外済み
 * - channels.json: Agentfile の channels セクションをそのまま保存
 * - Agentfile.resolved.json: base 継承を解決したビルド時点の Agentfile（シークレット env キーはマスク済み）
 *
 * NOTE: 生の Agentfile YAML は含めない。config layer は Fly イメージに丸ごと COPY されるため、
 * シークレット env 値を含む可能性があるファイルをイメージに焼き込まないよう sanitize 済みファイルのみ収録する。
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

export async function buildConfigLayer(agentfile: Agentfile): Promise<LayerData> {
  // openclaw.json の env もシークレットキーを除外してイメージに焼き込まない
  const sanitizedEnv = agentfile.config?.env
    ? Object.fromEntries(
        Object.entries(agentfile.config.env).filter(([key]) => !SECRET_ENV_KEYS.has(key)),
      )
    : {};

  const openclawConfig = {
    model: agentfile.config?.model ?? {},
    rag: agentfile.config?.rag ?? { enabled: false },
    env: sanitizedEnv,
  };

  const channels = agentfile.channels ?? {};

  // 生の Agentfile YAML は含めない:
  // config layer は Fly イメージに丸ごと COPY されるため、シークレット env 値を安全に除去できない
  // sanitize 済みの Agentfile.resolved.json のみを収録する
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
      name: "Agentfile.resolved.json",
      content: `${JSON.stringify(sanitizeAgentfileEnv(agentfile), null, 2)}\n`,
    },
  ];

  return packLayer(entries);
}
