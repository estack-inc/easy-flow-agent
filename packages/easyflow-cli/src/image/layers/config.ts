import type { Agentfile } from "../../agentfile/types.js";
import { type PackEntry, packLayer } from "../tar-pack.js";
import type { LayerData } from "../types.js";

/**
 * config レイヤー（openclaw.json / channels.json / Agentfile.resolved.json）を生成する。
 *
 * - openclaw.json: `{ model, rag, env }` の最小スキーマ（Phase 1）。env 値はすべて ${KEY} プレースホルダ
 * - channels.json: Agentfile の channels セクションをそのまま保存
 * - Agentfile.resolved.json: base 継承を解決したビルド時点の Agentfile（env 値はすべて ${KEY} プレースホルダ）
 *
 * NOTE: 生の Agentfile YAML は含めない。config layer は Fly イメージに丸ごと COPY されるため、
 * シークレット env 値を含む可能性があるファイルをイメージに焼き込まないよう sanitize 済みファイルのみ収録する。
 * env 値はホワイトリスト方式ではなく全キーをプレースホルダに変換することで、
 * 任意のシークレットが平文でイメージに混入するリスクを排除する。
 */

function sanitizeAgentfileEnv(agentfile: Agentfile): Agentfile {
  if (!agentfile.config?.env) return agentfile;
  // 全 env 値を ${KEY} プレースホルダに置換（実値をイメージに焼き込まない）
  const sanitizedEnv = Object.fromEntries(
    Object.keys(agentfile.config.env).map((key) => [key, `\${${key}}`]),
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
  // openclaw.json の env も全値を ${KEY} プレースホルダに変換してイメージに実値を焼き込まない
  const sanitizedEnv = agentfile.config?.env
    ? Object.fromEntries(Object.keys(agentfile.config.env).map((key) => [key, `\${${key}}`]))
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
