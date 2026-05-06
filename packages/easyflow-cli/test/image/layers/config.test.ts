import { describe, expect, it } from "vitest";
import type { Agentfile } from "../../../src/agentfile/types.js";
import { buildConfigLayer } from "../../../src/image/layers/config.js";
import { extractTarGz, readText } from "../helpers.js";

// biome-ignore lint/style/useTemplate: 意図的に文字列連結（template literal の lint 警告回避）
const placeholder = (name: string): string => "$" + "{" + name + "}";

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
  it("openclaw.json / channels.json / Agentfile.resolved.json を生成する（生の Agentfile は含まない）", async () => {
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
    const layer = await buildConfigLayer(agentfile);
    const files = await extractTarGz(layer.content);

    expect([...files.keys()].sort()).toEqual([
      "Agentfile.resolved.json",
      "channels.json",
      "openclaw.json",
    ]);

    const openclaw = JSON.parse(readText(files, "openclaw.json"));
    expect(openclaw.model).toEqual({ default: "claude-sonnet-4-6" });
    expect(openclaw.rag).toEqual({ enabled: true });
    // 非シークレット env 値はリテラルのまま保持される（プレースホルダに変換しない）
    expect(openclaw.env).toEqual({ LOG_LEVEL: "debug" });

    const channels = JSON.parse(readText(files, "channels.json"));
    expect(channels.slack).toEqual({ enabled: true });
    expect(channels.webchat).toEqual({ enabled: true, invite_codes: ["ABC"] });

    const resolvedAgentfile = JSON.parse(readText(files, "Agentfile.resolved.json"));
    // 非シークレット env 値はリテラルのまま保持される（deploy 時に render-openclaw-config が誤ってドロップしない）
    expect(resolvedAgentfile.config.env.LOG_LEVEL).toBe("debug");
    expect(resolvedAgentfile.channels.webchat.invite_codes).toEqual(["ABC"]);
  });

  it("既知シークレットキーはプレースホルダに変換され、非シークレット値はリテラルのまま保持される", async () => {
    const agentfile = baseAgentfile({
      config: {
        env: {
          LOG_LEVEL: "debug",
          ANTHROPIC_API_KEY: "sk-secret-value",
          PINECONE_API_KEY: "pc-secret",
          GEMINI_API_KEY: "gm-secret",
        },
      },
    });
    const layer = await buildConfigLayer(agentfile);
    const files = await extractTarGz(layer.content);

    const openclaw = JSON.parse(readText(files, "openclaw.json"));
    // 非シークレット値はリテラルのまま保持（render-openclaw-config が誤ってドロップしない）
    expect(openclaw.env.LOG_LEVEL).toBe("debug");
    // 既知シークレットキーはプレースホルダに変換（実値はイメージに含まれない）
    expect(openclaw.env.ANTHROPIC_API_KEY).toBe(placeholder("ANTHROPIC_API_KEY"));
    expect(openclaw.env.PINECONE_API_KEY).toBe(placeholder("PINECONE_API_KEY"));
    expect(openclaw.env.GEMINI_API_KEY).toBe(placeholder("GEMINI_API_KEY"));

    const resolvedAgentfile = JSON.parse(readText(files, "Agentfile.resolved.json"));
    expect(resolvedAgentfile.config.env.LOG_LEVEL).toBe("debug");
    expect(resolvedAgentfile.config.env.ANTHROPIC_API_KEY).toBe(placeholder("ANTHROPIC_API_KEY"));
    expect(resolvedAgentfile.config.env.PINECONE_API_KEY).toBe(placeholder("PINECONE_API_KEY"));
    expect(resolvedAgentfile.config.env.GEMINI_API_KEY).toBe(placeholder("GEMINI_API_KEY"));
  });

  it("config/channels 未指定時は空の openclaw.json / channels.json を出力する", async () => {
    const layer = await buildConfigLayer(baseAgentfile());
    const files = await extractTarGz(layer.content);

    const openclaw = JSON.parse(readText(files, "openclaw.json"));
    expect(openclaw).toEqual({ model: {}, rag: { enabled: false }, env: {} });

    const channels = JSON.parse(readText(files, "channels.json"));
    expect(channels).toEqual({});
  });
});
