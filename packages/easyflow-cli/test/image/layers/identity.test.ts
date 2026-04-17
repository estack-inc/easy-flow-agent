import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Agentfile } from "../../../src/agentfile/types.js";
import { buildIdentityLayer } from "../../../src/image/layers/identity.js";
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
      name: "テストエージェント",
      soul: "あなたはテスト用エージェントです。",
    },
    ...overrides,
  };
}

describe("buildIdentityLayer", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "easyflow-identity-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("IDENTITY.md / SOUL.md / POLICY.md / AGENTS-CORE.md を生成する", async () => {
    const agentfile = baseAgentfile({
      identity: {
        name: "フル機能",
        soul: "あなたは高機能エージェントです。",
        policy: ["個人情報を送信しない", "丁寧語で応答する"],
      },
      agents_core: {
        inline: "## コアルール\n- 常に丁寧語で応答する",
      },
    });

    const layer = await buildIdentityLayer(agentfile, tmpDir);
    expect(layer.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(layer.size).toBeGreaterThan(0);

    const files = await extractTarGz(layer.content);
    expect([...files.keys()].sort()).toEqual(
      ["AGENTS-CORE.md", "IDENTITY.md", "POLICY.md", "SOUL.md"].sort(),
    );
    expect(readText(files, "IDENTITY.md")).toContain("フル機能");
    expect(readText(files, "SOUL.md")).toContain("あなたは高機能エージェントです。");
    expect(readText(files, "POLICY.md")).toContain("- 個人情報を送信しない");
    expect(readText(files, "POLICY.md")).toContain("- 丁寧語で応答する");
    expect(readText(files, "AGENTS-CORE.md")).toContain("常に丁寧語で応答する");
    expect(layer.fileCount).toBe(4);
  });

  it("policy 未指定でも POLICY.md は空リストで生成される", async () => {
    const layer = await buildIdentityLayer(baseAgentfile(), tmpDir);
    const files = await extractTarGz(layer.content);
    expect(files.has("POLICY.md")).toBe(true);
    const body = readText(files, "POLICY.md");
    expect(body).toContain("# Policy");
    expect(body).not.toMatch(/^-\s/m);
  });

  it("agents_core 未指定時は AGENTS-CORE.md を含めない", async () => {
    const layer = await buildIdentityLayer(baseAgentfile(), tmpDir);
    const files = await extractTarGz(layer.content);
    expect(files.has("AGENTS-CORE.md")).toBe(false);
    expect(files.has("IDENTITY.md")).toBe(true);
    expect(files.has("SOUL.md")).toBe(true);
    expect(files.has("POLICY.md")).toBe(true);
    expect(layer.fileCount).toBe(3);
  });

  it("agents_core.file 指定時はファイル内容を読み込む", async () => {
    const corePath = path.join(tmpDir, "AGENTS-CORE.md");
    await fs.writeFile(corePath, "# Core Rules\n\nexternal file content\n");

    const agentfile = baseAgentfile({
      agents_core: { file: "AGENTS-CORE.md" },
    });
    const layer = await buildIdentityLayer(agentfile, tmpDir);
    const files = await extractTarGz(layer.content);
    expect(readText(files, "AGENTS-CORE.md")).toContain("external file content");
  });

  it("同一入力から同一ダイジェストを生成する（決定論）", async () => {
    const agentfile = baseAgentfile({
      identity: {
        name: "決定論",
        soul: "soul",
        policy: ["a", "b"],
      },
    });
    const layer1 = await buildIdentityLayer(agentfile, tmpDir);
    const layer2 = await buildIdentityLayer(agentfile, tmpDir);
    expect(layer1.digest).toBe(layer2.digest);
  });
});
