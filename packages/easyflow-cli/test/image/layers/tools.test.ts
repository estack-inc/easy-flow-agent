import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Agentfile } from "../../../src/agentfile/types.js";
import { buildToolsLayer } from "../../../src/image/layers/tools.js";
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

describe("buildToolsLayer", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "easyflow-tools-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("builtin のみ指定時に tools.json が書き出される", async () => {
    const agentfile = baseAgentfile({
      tools: { builtin: ["workflow-controller", "file-serve"] },
    });
    const layer = await buildToolsLayer(agentfile, tmpDir);
    const files = await extractTarGz(layer.content);
    expect(files.has("tools.json")).toBe(true);
    const toolsJson = JSON.parse(readText(files, "tools.json"));
    expect(toolsJson.builtin).toEqual(["workflow-controller", "file-serve"]);
    expect(toolsJson.custom).toEqual([]);
  });

  it("tools セクション未指定時は空 tools.json を出力する", async () => {
    const layer = await buildToolsLayer(baseAgentfile(), tmpDir);
    const files = await extractTarGz(layer.content);
    const toolsJson = JSON.parse(readText(files, "tools.json"));
    expect(toolsJson).toEqual({ builtin: [], custom: [] });
  });

  it("custom 指定時は custom/<name>/ にディレクトリがコピーされる", async () => {
    const customSrc = path.join(tmpDir, "my-tool");
    await fs.mkdir(customSrc, { recursive: true });
    await fs.writeFile(path.join(customSrc, "index.ts"), "export const foo = 1;\n");
    await fs.writeFile(path.join(customSrc, "helper.ts"), "export const bar = 2;\n");

    const agentfile = baseAgentfile({
      tools: {
        custom: [{ path: "my-tool", name: "my-tool" }],
      },
    });
    const layer = await buildToolsLayer(agentfile, tmpDir);
    const files = await extractTarGz(layer.content);

    expect(files.has("custom/my-tool/index.ts")).toBe(true);
    expect(files.has("custom/my-tool/helper.ts")).toBe(true);
    expect(readText(files, "custom/my-tool/index.ts")).toContain("foo");

    const toolsJson = JSON.parse(readText(files, "tools.json"));
    expect(toolsJson.custom).toEqual([{ name: "my-tool", source: "custom/my-tool" }]);
  });

  it("単一ファイルの custom tool を custom/<name>/<basename> として格納する", async () => {
    const customFile = path.join(tmpDir, "hello.ts");
    await fs.writeFile(customFile, "export const hello = 1;\n");

    const agentfile = baseAgentfile({
      tools: {
        custom: [{ path: "hello.ts", name: "hello-tool" }],
      },
    });
    const layer = await buildToolsLayer(agentfile, tmpDir);
    const files = await extractTarGz(layer.content);
    expect(files.has("custom/hello-tool/hello.ts")).toBe(true);
  });
});
