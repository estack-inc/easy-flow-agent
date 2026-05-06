import type { Agentfile } from "../../agentfile/types.js";
import { type PackEntry, packLayer } from "../tar-pack.js";
import type { LayerData } from "../types.js";

/**
 * config レイヤー（openclaw.json / channels.json / Agentfile.resolved.json）を生成する。
 *
 * - openclaw.json: `{ model, rag, env }` の最小スキーマ（Phase 1）。secret-like env 値は ${KEY} プレースホルダ
 * - channels.json: Agentfile の channels セクションをそのまま保存
 * - Agentfile.resolved.json: base 継承を解決したビルド時点の Agentfile（secret-like env 値は ${KEY} プレースホルダ）
 *
 * NOTE: 生の Agentfile YAML は含めない。config layer は Fly イメージに丸ごと COPY されるため、
 * シークレット env 値を含む可能性があるファイルをイメージに焼き込まないよう sanitize 済みファイルのみ収録する。
 * secret-like 判定は固定ホワイトリストだけでなくキー名パターンも見る。
 * LOG_LEVEL 等の非シークレット値はリテラルのまま保持する。
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
const SECRET_ENV_KEY_PATTERN =
  /(^|_)(API_?KEY|SECRET|TOKEN|PASSWORD|PASS|CREDENTIAL|PRIVATE_?KEY|AUTH)(_|$)/i;
const FULL_PLACEHOLDER_PATTERN = /^\$\{[A-Z_][A-Z0-9_]*\}$/;

function isSecretEnvKey(key: string): boolean {
  return SECRET_ENV_KEYS.has(key) || SECRET_ENV_KEY_PATTERN.test(key);
}

function sanitizeEnvValue(key: string, value: string): string {
  if (FULL_PLACEHOLDER_PATTERN.test(value)) {
    return value;
  }
  if (isSecretEnvKey(key)) {
    return `\${${key}}`;
  }
  return value;
}

function sanitizeEnv(env: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env ?? {}).map(([key, value]) => [key, sanitizeEnvValue(key, value)]),
  );
}

function sanitizeAgentfileEnv(agentfile: Agentfile): Agentfile {
  if (!agentfile.config?.env) return agentfile;
  return {
    ...agentfile,
    config: {
      ...agentfile.config,
      env: sanitizeEnv(agentfile.config.env),
    },
  };
}

export async function buildConfigLayer(agentfile: Agentfile): Promise<LayerData> {
  const sanitizedEnv = sanitizeEnv(agentfile.config?.env);

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
