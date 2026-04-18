import { describe, expect, it } from "vitest";
import type { Agentfile } from "../../src/agentfile/types.js";
import { buildOpenclawConfig } from "../../src/deploy/openclaw-config.js";
import { EasyflowError } from "../../src/utils/errors.js";

function makeMinimalAgentfile(overrides: Partial<Agentfile> = {}): Agentfile {
  return {
    apiVersion: "easyflow/v1",
    kind: "Agent",
    metadata: {
      name: "test-agent",
      version: "1.0.0",
      description: "Test agent",
      author: "test",
    },
    identity: {
      name: "Test Agent",
      soul: "You are a helpful assistant.",
    },
    ...overrides,
  };
}

describe("buildOpenclawConfig", () => {
  it("最小 Agentfile でエラーなく生成できる", () => {
    const config = buildOpenclawConfig({
      agentfile: makeMinimalAgentfile(),
      secrets: {},
    });

    expect(config.gateway.auth.mode).toBe("token");
    expect(config.gateway.auth.token).toBeTruthy();
    expect(config.session.storage).toMatchObject({ type: "file", path: "/data/sessions" });
    expect(config.plugins.allow).toContain("easyflow-gateway");
  });

  it("GATEWAY_TOKEN がシークレットにある場合はそれを使用する", () => {
    const config = buildOpenclawConfig({
      agentfile: makeMinimalAgentfile(),
      secrets: { GATEWAY_TOKEN: "my-fixed-token" },
    });

    expect(config.gateway.auth.token).toBe("my-fixed-token");
  });

  it("GATEWAY_TOKEN がない場合は自動生成する", () => {
    const config = buildOpenclawConfig({
      agentfile: makeMinimalAgentfile(),
      secrets: {},
    });

    expect(config.gateway.auth.token).toBeTruthy();
    expect(config.gateway.auth.token.length).toBeGreaterThan(0);
  });

  it("ANTHROPIC_API_KEY がシークレットにある場合は env に含める", () => {
    const config = buildOpenclawConfig({
      agentfile: makeMinimalAgentfile(),
      secrets: { ANTHROPIC_API_KEY: "sk-test" },
    });

    expect(config.env.ANTHROPIC_API_KEY).toBe("sk-test");
  });

  it("GEMINI_API_KEY がない場合は tools.media を含めない", () => {
    const config = buildOpenclawConfig({
      agentfile: makeMinimalAgentfile(),
      secrets: {},
    });

    expect(config.tools?.media).toBeUndefined();
  });

  it("GEMINI_API_KEY がある場合は tools.media を含める", () => {
    const config = buildOpenclawConfig({
      agentfile: makeMinimalAgentfile(),
      secrets: { GEMINI_API_KEY: "gemini-key" },
    });

    expect(config.tools?.media).toBeTruthy();
  });

  it("Slack チャンネルが有効でトークンあり: channels.slack を設定する", () => {
    const agentfile = makeMinimalAgentfile({
      channels: { slack: { enabled: true } },
    });

    const config = buildOpenclawConfig({
      agentfile,
      secrets: { SLACK_BOT_TOKEN: "xoxb-token" },
    });

    expect(config.channels.slack).toMatchObject({
      enabled: true,
      botToken: "xoxb-token",
    });
  });

  it("Slack チャンネルが有効でトークンなし: EasyflowError をスローする", () => {
    const agentfile = makeMinimalAgentfile({
      channels: { slack: { enabled: true } },
    });

    expect(() =>
      buildOpenclawConfig({
        agentfile,
        secrets: {},
      }),
    ).toThrow(EasyflowError);
  });

  it("Line チャンネルが有効でトークンあり: channels.line を設定する", () => {
    const agentfile = makeMinimalAgentfile({
      channels: { line: { enabled: true } },
    });

    const config = buildOpenclawConfig({
      agentfile,
      secrets: {
        LINE_ACCESS_TOKEN: "line-token",
        LINE_CHANNEL_SECRET: "line-secret",
      },
    });

    expect(config.channels.line).toMatchObject({
      enabled: true,
      accessToken: "line-token",
      channelSecret: "line-secret",
    });
  });

  it("Line チャンネルが有効でトークン不足: EasyflowError をスローする", () => {
    const agentfile = makeMinimalAgentfile({
      channels: { line: { enabled: true } },
    });

    expect(() =>
      buildOpenclawConfig({
        agentfile,
        secrets: { LINE_ACCESS_TOKEN: "token-only" },
      }),
    ).toThrow(EasyflowError);
  });

  it("Webchat チャンネルが有効: plugins.allow に easy-flow-webchat を含める", () => {
    const agentfile = makeMinimalAgentfile({
      channels: { webchat: { enabled: true } },
    });

    const config = buildOpenclawConfig({
      agentfile,
      secrets: {},
    });

    expect(config.plugins.allow).toContain("easy-flow-webchat");
    expect(config.webchat).toBeDefined();
  });

  it("RAG が有効: pinecone-memory エントリが enabled=true", () => {
    const agentfile = makeMinimalAgentfile({
      config: { rag: { enabled: true } },
    });

    const config = buildOpenclawConfig({
      agentfile,
      secrets: {},
    });

    expect(config.plugins.entries["pinecone-memory"]?.enabled).toBe(true);
  });

  it("RAG が無効: pinecone-memory エントリが enabled=false", () => {
    const agentfile = makeMinimalAgentfile({
      config: { rag: { enabled: false } },
    });

    const config = buildOpenclawConfig({
      agentfile,
      secrets: {},
    });

    expect(config.plugins.entries["pinecone-memory"]?.enabled).toBe(false);
  });

  it("モデル設定が Agentfile に含まれる場合は agents に反映する", () => {
    const agentfile = makeMinimalAgentfile({
      config: { model: { default: "claude-opus-4-5" } },
    });

    const config = buildOpenclawConfig({
      agentfile,
      secrets: {},
    });

    expect((config.agents.default as Record<string, unknown>).model).toBe("claude-opus-4-5");
  });
});
