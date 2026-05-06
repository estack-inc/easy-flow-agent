import type { Agentfile } from "../../agentfile/types.js";
import { type PackEntry, packLayer } from "../tar-pack.js";
import type { LayerData } from "../types.js";

/**
 * config レイヤー（openclaw.json / channels.json / Agentfile.resolved.json）を生成する。
 *
 * - openclaw.json: `{ model, rag, env }` の最小スキーマ（Phase 1）。既知 secret キーのみ ${KEY} プレースホルダ、非 secret 値はリテラル保持
 * - channels.json: Agentfile の channels セクションをそのまま保存
 * - Agentfile.resolved.json: base 継承を解決したビルド時点の Agentfile（既知 secret キーのみ ${KEY} プレースホルダ）
 *
 * NOTE: 生の Agentfile YAML は含めない。config layer は Fly イメージに丸ごと COPY されるため、
 * シークレット env 値を含む可能性があるファイルをイメージに焼き込まないよう sanitize 済みファイルのみ収録する。
 * 既知シークレットキーのみをプレースホルダに変換し、LOG_LEVEL 等の非シークレット値はリテラルのまま保持する。
 * これにより render-openclaw-config.js が非シークレット値を process.env 未設定時に誤ってドロップするのを防ぐ。
 */

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
  // 既知シークレットキーのみ ${KEY} プレースホルダに置換。非シークレット値はリテラルのまま保持。
  const sanitizedEnv = Object.fromEntries(
    Object.entries(agentfile.config.env).map(([key, value]) => [
      key,
      SECRET_ENV_KEYS.has(key) ? `\${${key}}` : value,
    ]),
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
  // openclaw.json の env は既知シークレットキーのみ ${KEY} プレースホルダに変換。非シークレット値はリテラルのまま保持。
  const sanitizedEnv = agentfile.config?.env
    ? Object.fromEntries(
        Object.entries(agentfile.config.env).map(([key, value]) => [
          key,
          SECRET_ENV_KEYS.has(key) ? `\${${key}}` : value,
        ]),
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
