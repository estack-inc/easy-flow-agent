import { describe, expect, it } from "vitest";
import type { Agentfile } from "../../src/agentfile/types.js";
import { buildImageConfig, buildOciManifest } from "../../src/image/oci.js";
import type { LayerInfo } from "../../src/image/types.js";

function baseAgentfile(overrides: Partial<Agentfile> = {}): Agentfile {
  return {
    apiVersion: "easyflow/v1",
    kind: "Agent",
    metadata: {
      name: "test-agent",
      version: "1.2.3",
      description: "テスト",
      author: "estack-inc",
    },
    identity: {
      name: "テスト",
      soul: "soul",
    },
    ...overrides,
  };
}

describe("buildImageConfig", () => {
  it("ImageConfigFile の全フィールドが出力される", async () => {
    const agentfile = baseAgentfile({
      base: "estack-inc/monitor:latest",
      tools: { builtin: ["workflow-controller", "file-serve"] },
      channels: {
        slack: { enabled: true },
        line: { enabled: false },
        webchat: { enabled: true },
      },
    });
    const config = buildImageConfig(agentfile, {
      createdAt: "2026-04-17T00:00:00.000Z",
    });
    expect(config.schemaVersion).toBe(1);
    expect(config.agentfile).toBe("easyflow/v1");
    expect(config.metadata).toEqual({
      name: "test-agent",
      version: "1.2.3",
      description: "テスト",
      author: "estack-inc",
      createdAt: "2026-04-17T00:00:00.000Z",
      buildTool: expect.stringContaining("easyflow"),
    });
    expect(config.base).toEqual({ ref: "estack-inc/monitor:latest" });
    expect(config.knowledge).toEqual({ totalChunks: 0, totalTokens: 0, sources: [] });
    expect(config.tools).toEqual(["workflow-controller", "file-serve"]);
    expect(config.channels).toEqual(["slack", "webchat"]);
  });

  it("base 未指定時は base フィールドを省略する", async () => {
    const config = buildImageConfig(baseAgentfile(), { createdAt: "2026-04-17T00:00:00.000Z" });
    expect(config.base).toBeUndefined();
  });
});

describe("buildOciManifest", () => {
  const configDescriptor = {
    mediaType: "application/vnd.easyflow.agent.config.v1+json",
    digest: `sha256:${"a".repeat(64)}`,
    size: 123,
  };
  const layers: Array<{ name: LayerInfo["name"]; descriptor: any }> = [
    {
      name: "identity",
      descriptor: {
        mediaType: "application/vnd.easyflow.agent.layer.v1.tar+gzip",
        digest: `sha256:${"1".repeat(64)}`,
        size: 100,
      },
    },
    {
      name: "knowledge",
      descriptor: {
        mediaType: "application/vnd.easyflow.agent.layer.v1.tar+gzip",
        digest: `sha256:${"2".repeat(64)}`,
        size: 50,
      },
    },
    {
      name: "tools",
      descriptor: {
        mediaType: "application/vnd.easyflow.agent.layer.v1.tar+gzip",
        digest: `sha256:${"3".repeat(64)}`,
        size: 60,
      },
    },
    {
      name: "config",
      descriptor: {
        mediaType: "application/vnd.easyflow.agent.layer.v1.tar+gzip",
        digest: `sha256:${"4".repeat(64)}`,
        size: 70,
      },
    },
  ];

  it("schemaVersion=2 / mediaType / config / layers が正しく組み立てられる", () => {
    const manifest = buildOciManifest(baseAgentfile(), configDescriptor, layers, {
      createdAt: "2026-04-17T00:00:00.000Z",
    });
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.mediaType).toBe("application/vnd.easyflow.agent.manifest.v1+json");
    expect(manifest.config).toBe(configDescriptor);
    expect(manifest.layers).toHaveLength(4);
    expect(manifest.layers[0].annotations?.["org.easyflow.layer.name"]).toBe("identity");
  });

  it("必須アノテーション 8 種が付与される", () => {
    const agentfile = baseAgentfile({
      base: "estack-inc/monitor:latest",
      tools: { builtin: ["workflow-controller", "file-serve"] },
      channels: { slack: { enabled: true }, webchat: { enabled: true }, line: { enabled: false } },
    });
    const manifest = buildOciManifest(agentfile, configDescriptor, layers, {
      createdAt: "2026-04-17T00:00:00.000Z",
    });
    const ann = manifest.annotations ?? {};
    expect(ann["org.easyflow.version"]).toBe("1.2.3");
    expect(ann["org.easyflow.base"]).toBe("estack-inc/monitor:latest");
    expect(ann["org.easyflow.knowledge.chunks"]).toBe("0");
    expect(ann["org.easyflow.knowledge.tokens"]).toBe("0");
    expect(ann["org.easyflow.tools"]).toBe("workflow-controller,file-serve");
    expect(ann["org.easyflow.channels"]).toBe("slack,webchat");
    expect(ann["org.opencontainers.image.created"]).toBe("2026-04-17T00:00:00.000Z");
    expect(ann["org.opencontainers.image.authors"]).toBe("estack-inc");
  });

  it("resolvedBase 指定時は annotation の base にそれを使う", () => {
    const manifest = buildOciManifest(baseAgentfile(), configDescriptor, layers, {
      createdAt: "2026-04-17T00:00:00.000Z",
      resolvedBase: "monitor",
    });
    expect(manifest.annotations?.["org.easyflow.base"]).toBe("monitor");
  });
});
