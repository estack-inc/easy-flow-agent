import type { Agentfile } from "../../agentfile/types.js";
import { packLayer } from "../tar-pack.js";
import type { KnowledgeSourceStats, LayerData } from "../types.js";

interface KnowledgeManifest {
  totalChunks: number;
  totalTokens: number;
  sources: KnowledgeSourceStats[];
}

/**
 * knowledge レイヤー（Phase 1 は manifest.json のみの空レイヤー）を生成する。
 *
 * - `agentfile.knowledge.sources` が指定されていた場合は警告ログを出し、sources[] に
 *   `{ path, type, description, chunks: 0, tokens: 0 }` を記録する。
 * - `chunks.jsonl` / `vectors.bin` は Phase 3 で追加予定。
 */
export async function buildKnowledgeLayer(agentfile: Agentfile): Promise<LayerData> {
  const sources = agentfile.knowledge?.sources ?? [];
  if (sources.length > 0) {
    console.warn(
      `Warning: knowledge.sources は Phase 3 で実装予定です (${sources.length} 件のソースをスキップ)`,
    );
  }

  const manifest: KnowledgeManifest = {
    totalChunks: 0,
    totalTokens: 0,
    sources: sources.map((s) => ({
      path: s.path,
      type: s.type,
      description: s.description,
      chunks: 0,
      tokens: 0,
    })),
  };

  return packLayer([
    {
      kind: "file",
      name: "manifest.json",
      content: `${JSON.stringify(manifest, null, 2)}\n`,
    },
  ]);
}
