import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectImage } from "../../src/inspect/inspector.js";
import { ImageStore } from "../../src/store/image-store.js";
import type { ImageData } from "../../src/store/types.js";
import { EasyflowError } from "../../src/utils/errors.js";

function createTestManifest(layers: { name: string; digest: string; size: number }[]) {
  return {
    schemaVersion: 2,
    config: { digest: "sha256:configdigest", size: 100 },
    layers: layers.map((l) => ({
      digest: l.digest,
      size: l.size,
      annotations: { "org.easyflow.layer.name": l.name },
    })),
  };
}

function createTestImageData(
  overrides: Partial<{
    name: string;
    description: string;
    tools: string[];
    channels: string[];
    knowledgeSources: { path: string; type: string; chunks: number; tokens: number }[];
    base: { ref: string; digest?: string };
  }> = {},
): ImageData {
  const {
    name = "test-agent",
    description = "A test agent",
    tools = ["workflow-controller"],
    channels = ["slack"],
    knowledgeSources = [],
    base,
  } = overrides;

  return {
    manifest: createTestManifest([
      { name: "identity", digest: "sha256:identity123", size: 512 },
      { name: "knowledge", digest: "sha256:knowledge123", size: 1024 },
      { name: "tools", digest: "sha256:tools123", size: 256 },
      { name: "config", digest: "sha256:config123", size: 128 },
    ]),
    config: {
      schemaVersion: 1,
      agentfile: "easyflow/v1",
      metadata: {
        name,
        version: "1.0.0",
        description,
        author: "tester",
        createdAt: "2026-04-17T00:00:00.000Z",
        buildTool: "easyflow-cli/0.1.0",
      },
      ...(base ? { base } : {}),
      knowledge: {
        totalChunks: knowledgeSources.reduce((acc, s) => acc + s.chunks, 0),
        totalTokens: knowledgeSources.reduce((acc, s) => acc + s.tokens, 0),
        sources: knowledgeSources,
      },
      tools,
      channels,
    },
    layers: new Map([
      ["identity", Buffer.from("identity-tar-gz")],
      ["knowledge", Buffer.from("knowledge-tar-gz")],
      ["tools", Buffer.from("tools-tar-gz")],
      ["config", Buffer.from("config-tar-gz")],
    ]),
  };
}

describe("inspectImage", () => {
  let tmpDir: string;
  let store: ImageStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "easyflow-inspect-test-"));
    store = new ImageStore(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("既存イメージで完全な InspectReport が返る", async () => {
    const ref = "org/test-agent:1.0.0";
    await store.save(ref, createTestImageData());

    const report = await inspectImage(ref, store);

    expect(report.ref).toBe(ref);
    expect(report.metadata.name).toBe("test-agent");
    expect(report.metadata.version).toBe("1.0.0");
    expect(report.metadata.description).toBe("A test agent");
    expect(report.metadata.author).toBe("tester");
    expect(report.tools).toEqual(["workflow-controller"]);
    expect(report.channels).toEqual(["slack"]);
    expect(report.knowledge.totalChunks).toBe(0);
    expect(report.knowledge.totalTokens).toBe(0);
    expect(report.knowledge.sources).toHaveLength(0);
    expect(report.layers).toHaveLength(4);
    expect(report.layers.map((l) => l.name)).toEqual(["identity", "knowledge", "tools", "config"]);
  });

  it("存在しない ref で EasyflowError がスローされる", async () => {
    await expect(inspectImage("org/missing:1.0.0", store)).rejects.toThrow(EasyflowError);
    await expect(inspectImage("org/missing:1.0.0", store)).rejects.toThrow(
      "image not found: org/missing:1.0.0",
    );
  });

  it("base あり の場合 metadata.base に ref が含まれる", async () => {
    const ref = "org/based-agent:2.0.0";
    await store.save(
      ref,
      createTestImageData({ base: { ref: "estack-inc/monitor:latest", digest: "sha256:base123" } }),
    );

    const report = await inspectImage(ref, store);

    expect(report.metadata.base).toBeDefined();
    expect(report.metadata.base?.ref).toBe("estack-inc/monitor:latest");
    expect(report.metadata.base?.digest).toBe("sha256:base123");
  });

  it("base なし の場合 metadata.base は undefined", async () => {
    const ref = "org/no-base:1.0.0";
    await store.save(ref, createTestImageData());

    const report = await inspectImage(ref, store);

    expect(report.metadata.base).toBeUndefined();
  });

  it("knowledge sources がある場合に sources が含まれる", async () => {
    const ref = "org/knowledge-agent:1.0.0";
    await store.save(
      ref,
      createTestImageData({
        knowledgeSources: [
          { path: "./docs", type: "agents_rule", chunks: 10, tokens: 500 },
          { path: "./data", type: "customer_doc", chunks: 5, tokens: 200 },
        ],
      }),
    );

    const report = await inspectImage(ref, store);

    expect(report.knowledge.totalChunks).toBe(15);
    expect(report.knowledge.totalTokens).toBe(700);
    expect(report.knowledge.sources).toHaveLength(2);
    expect(report.knowledge.sources[0].path).toBe("./docs");
  });

  it("layers の fileCount が数値として返る", async () => {
    const ref = "org/layers-agent:1.0.0";
    await store.save(ref, createTestImageData());

    const report = await inspectImage(ref, store);

    for (const layer of report.layers) {
      expect(typeof layer.fileCount).toBe("number");
      expect(typeof layer.size).toBe("number");
      expect(typeof layer.digest).toBe("string");
    }
  });
});
