import type { Agentfile } from "../../agentfile/types.js";
import { packLayer, type PackEntry } from "../tar-pack.js";
import type { LayerData } from "../types.js";

/**
 * config レイヤー（openclaw.json / channels.json / Agentfile）を生成する。
 *
 * - openclaw.json: `{ model, rag, env }` の最小スキーマ（Phase 1）
 * - channels.json: Agentfile の channels セクションをそのまま保存
 * - Agentfile: 元 YAML テキストを再現用に保存
 */
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
  ];

  return packLayer(entries);
}
