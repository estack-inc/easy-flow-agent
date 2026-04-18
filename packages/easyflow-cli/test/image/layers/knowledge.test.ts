import { describe, expect, it, vi } from "vitest";
import type { Agentfile } from "../../../src/agentfile/types.js";
import { buildKnowledgeLayer } from "../../../src/image/layers/knowledge.js";
import { extractTarGz, readText } from "../helpers.js";

function baseAgentfile(overrides: Partial<Agentfile> = {}): Agentfile {
  return {
    apiVersion: "easyflow/v1",
    kind: "Agent",
    metadata: {
      name: "test-agent",
      version: "1.0.0",
      description: "テスト",
      author: "estack",
    },
    identity: {
      name: "テスト",
      soul: "soul",
    },
    ...overrides,
  };
}

describe("buildKnowledgeLayer", () => {
  it("knowledge 未指定時は空 manifest.json のみ出力する", async () => {
    const layer = await buildKnowledgeLayer(baseAgentfile());
    const files = await extractTarGz(layer.content);
    expect([...files.keys()]).toEqual(["manifest.json"]);
    const manifest = JSON.parse(readText(files, "manifest.json"));
    expect(manifest).toEqual({ totalChunks: 0, totalTokens: 0, sources: [] });
  });

  it("knowledge.sources 指定時も Phase 1 では chunks=0 / tokens=0 で記録する", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agentfile = baseAgentfile({
      knowledge: {
        sources: [
          { path: "./docs", type: "agents_rule", description: "ルール集" },
          { path: "./data", type: "customer_doc", description: "顧客" },
        ],
      },
    });
    const layer = await buildKnowledgeLayer(agentfile);
    const files = await extractTarGz(layer.content);
    const manifest = JSON.parse(readText(files, "manifest.json"));
    expect(manifest.totalChunks).toBe(0);
    expect(manifest.totalTokens).toBe(0);
    expect(manifest.sources).toEqual([
      { path: "./docs", type: "agents_rule", description: "ルール集", chunks: 0, tokens: 0 },
      { path: "./data", type: "customer_doc", description: "顧客", chunks: 0, tokens: 0 },
    ]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
