import { describe, expect, it } from "vitest";
import type { Agentfile } from "../../../src/agentfile/types.js";
import { buildConfigLayer } from "../../../src/image/layers/config.js";
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

describe("buildConfigLayer", () => {
  it("openclaw.json / channels.json / Agentfile を生成する", async () => {
    const rawYaml = "apiVersion: easyflow/v1\nkind: Agent\n# dummy\n";
    const agentfile = baseAgentfile({
      config: {
        model: { default: "claude-sonnet-4-6" },
        rag: { enabled: true },
        env: { LOG_LEVEL: "debug" },
      },
      channels: {
        slack: { enabled: true },
        webchat: { enabled: true, invite_codes: ["ABC"] },
      },
    });
    const layer = await buildConfigLayer(agentfile, rawYaml);
    const files = await extractTarGz(layer.content);

    expect([...files.keys()].sort()).toEqual(["Agentfile", "channels.json", "openclaw.json"]);

    const openclaw = JSON.parse(readText(files, "openclaw.json"));
    expect(openclaw.model).toEqual({ default: "claude-sonnet-4-6" });
    expect(openclaw.rag).toEqual({ enabled: true });
    expect(openclaw.env).toEqual({ LOG_LEVEL: "debug" });

    const channels = JSON.parse(readText(files, "channels.json"));
    expect(channels.slack).toEqual({ enabled: true });
    expect(channels.webchat).toEqual({ enabled: true, invite_codes: ["ABC"] });

    expect(readText(files, "Agentfile")).toBe(rawYaml);
  });

  it("config/channels 未指定時は空の openclaw.json / channels.json を出力する", async () => {
    const rawYaml = "apiVersion: easyflow/v1\n";
    const layer = await buildConfigLayer(baseAgentfile(), rawYaml);
    const files = await extractTarGz(layer.content);

    const openclaw = JSON.parse(readText(files, "openclaw.json"));
    expect(openclaw).toEqual({ model: {}, rag: { enabled: false }, env: {} });

    const channels = JSON.parse(readText(files, "channels.json"));
    expect(channels).toEqual({});
  });
});
