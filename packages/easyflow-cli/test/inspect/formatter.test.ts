import { describe, expect, it } from "vitest";
import { formatHuman, formatJson } from "../../src/inspect/formatter.js";
import type { InspectReport } from "../../src/inspect/types.js";

function createReport(overrides: Partial<InspectReport> = {}): InspectReport {
  return {
    ref: "org/test-agent:1.0.0",
    digest: "sha256:abc123",
    size: 4096,
    createdAt: "2026-04-17T00:00:00.000Z",
    metadata: {
      name: "test-agent",
      version: "1.0.0",
      description: "A test agent",
      author: "tester",
      base: { ref: "estack-inc/monitor:latest" },
    },
    identity: {
      name: "テストエージェント",
      soulPreview: "あなたはテスト用エージェントです。",
      policyCount: 2,
    },
    knowledge: {
      totalChunks: 10,
      totalTokens: 500,
      sources: [
        { path: "./docs", type: "agents_rule", chunks: 5, tokens: 250 },
        { path: "./data", type: "customer_doc", chunks: 5, tokens: 250 },
      ],
    },
    tools: ["workflow-controller", "file-serve"],
    channels: ["slack", "webchat"],
    layers: [
      { name: "identity", size: 512, fileCount: 3, digest: "sha256:identity123" },
      { name: "knowledge", size: 1024, fileCount: 2, digest: "sha256:knowledge123" },
      { name: "tools", size: 256, fileCount: 1, digest: "sha256:tools123" },
      { name: "config", size: 128, fileCount: 1, digest: "sha256:config123" },
    ],
    ...overrides,
  };
}

describe("formatHuman", () => {
  it("=== Image === セクションを含む", () => {
    const output = formatHuman(createReport());
    expect(output).toContain("=== Image ===");
    expect(output).toContain("org/test-agent:1.0.0");
    expect(output).toContain("sha256:abc123");
  });

  it("=== Metadata === セクションを含む", () => {
    const output = formatHuman(createReport());
    expect(output).toContain("=== Metadata ===");
    expect(output).toContain("test-agent");
    expect(output).toContain("1.0.0");
    expect(output).toContain("A test agent");
    expect(output).toContain("tester");
    expect(output).toContain("estack-inc/monitor:latest");
  });

  it("=== Identity === セクションを含む", () => {
    const output = formatHuman(createReport());
    expect(output).toContain("=== Identity ===");
    expect(output).toContain("テストエージェント");
    expect(output).toContain("あなたはテスト用エージェントです。");
  });

  it("=== Knowledge === セクションを含む", () => {
    const output = formatHuman(createReport());
    expect(output).toContain("=== Knowledge ===");
    expect(output).toContain("Total Chunks: 10");
    expect(output).toContain("Total Tokens: 500");
    expect(output).toContain("./docs");
    expect(output).toContain("agents_rule");
  });

  it("=== Tools === セクションを含む", () => {
    const output = formatHuman(createReport());
    expect(output).toContain("=== Tools ===");
    expect(output).toContain("workflow-controller");
    expect(output).toContain("file-serve");
  });

  it("=== Channels === セクションを含む", () => {
    const output = formatHuman(createReport());
    expect(output).toContain("=== Channels ===");
    expect(output).toContain("slack");
    expect(output).toContain("webchat");
  });

  it("=== Layers === セクションを含む", () => {
    const output = formatHuman(createReport());
    expect(output).toContain("=== Layers ===");
    expect(output).toContain("identity");
    expect(output).toContain("knowledge");
    expect(output).toContain("tools");
    expect(output).toContain("config");
  });

  it("tools が空の場合 (none) を表示", () => {
    const output = formatHuman(createReport({ tools: [] }));
    expect(output).toContain("=== Tools ===");
    expect(output).toContain("(none)");
  });

  it("channels が空の場合 (none) を表示", () => {
    const output = formatHuman(createReport({ channels: [] }));
    expect(output).toContain("=== Channels ===");
    expect(output).toContain("(none)");
  });

  it("knowledge sources が空の場合 (none) を表示", () => {
    const output = formatHuman(
      createReport({
        knowledge: { totalChunks: 0, totalTokens: 0, sources: [] },
      }),
    );
    expect(output).toContain("Sources: (none)");
  });
});

describe("formatJson", () => {
  it("有効な JSON 文字列を返す", () => {
    const output = formatJson(createReport());
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it("パースした結果が InspectReport と等価", () => {
    const report = createReport();
    const parsed = JSON.parse(formatJson(report));
    expect(parsed).toEqual(report);
  });

  it("ref が JSON に含まれる", () => {
    const output = formatJson(createReport());
    const parsed = JSON.parse(output);
    expect(parsed.ref).toBe("org/test-agent:1.0.0");
  });
});
