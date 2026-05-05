import { describe, expect, it } from "vitest";
import type { Agentfile } from "../../src/agentfile/types.js";
import { buildOpenclawConfig } from "../../src/deploy/openclaw-config.js";

// biome-ignore lint/style/useTemplate: 意図的に文字列連結（template literal の lint 警告回避）
const placeholder = (name: string): string => "$" + "{" + name + "}";

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
    expect(config.gateway.auth.token).toBe(placeholder("GATEWAY_TOKEN"));
    expect(config.session.storage).toMatchObject({ type: "file", path: "/data/sessions" });
    expect(config.plugins.allow).toContain("easyflow-gateway");
    expect(config.plugins.allow).toContain("lossless-claw");
    expect(config.plugins.allow).toContain("file-serve");
    expect(config.plugins.allow).toContain("model-router");
    expect(config.plugins.slots?.contextEngine).toBe("lossless-claw");
    expect(config.env.OPENCLAW_AGENT_ID).toBe("test-agent");
    expect(config.plugins.entries["lossless-claw"]).toMatchObject({
      enabled: true,
      config: {
        summaryModel: "claude-haiku-4-5",
        summaryProvider: "anthropic",
      },
    });
  });

  it("GATEWAY_TOKEN がシークレットにあっても gateway token はプレースホルダを使用する", () => {
    const config = buildOpenclawConfig({
      agentfile: makeMinimalAgentfile(),
      secrets: { GATEWAY_TOKEN: "my-fixed-token" },
    });

    expect(config.gateway.auth.token).toBe(placeholder("GATEWAY_TOKEN"));
  });

  it("GATEWAY_TOKEN がなくても gateway token はプレースホルダを使用する", () => {
    const config = buildOpenclawConfig({
      agentfile: makeMinimalAgentfile(),
      secrets: {},
    });

    expect(config.gateway.auth.token).toBe(placeholder("GATEWAY_TOKEN"));
  });

  it("シークレット API キーは env に含めない（Fly secrets から process.env で参照）", () => {
    const config = buildOpenclawConfig({
      agentfile: makeMinimalAgentfile(),
      secrets: {
        ANTHROPIC_API_KEY: "sk-test",
        GEMINI_API_KEY: "gm-test",
        OPENAI_API_KEY: "oa-test",
        PINECONE_API_KEY: "pc-test",
      },
    });

    expect(config.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(config.env.GEMINI_API_KEY).toBeUndefined();
    expect(config.env.OPENAI_API_KEY).toBeUndefined();
    expect(config.env.PINECONE_API_KEY).toBeUndefined();
  });

  it("GEMINI_API_KEY が local/Fly のどちらにもない場合は tools.media を含めない", () => {
    const config = buildOpenclawConfig({
      agentfile: makeMinimalAgentfile(),
      secrets: {},
    });

    expect(config.tools?.media).toBeUndefined();
  });

  it("GEMINI_API_KEY がある場合は tools.media を含めるが apiKey は含めない", () => {
    const config = buildOpenclawConfig({
      agentfile: makeMinimalAgentfile(),
      secrets: { GEMINI_API_KEY: "gemini-key" },
    });

    expect(config.tools?.media).toEqual({ enabled: true });
  });

  it("GEMINI_API_KEY が local になくても既存 Fly secrets にあれば tools.media を含める", () => {
    const config = buildOpenclawConfig({
      agentfile: makeMinimalAgentfile(),
      secrets: {},
      availableSecretKeys: ["GEMINI_API_KEY"],
    });

    expect(config.tools?.media).toEqual({ enabled: true });
  });

  it("PINECONE_API_KEY が利用可能な場合は pinecone-memory を contextEngine にする", () => {
    const config = buildOpenclawConfig({
      agentfile: makeMinimalAgentfile(),
      secrets: {},
      availableSecretKeys: ["PINECONE_API_KEY"],
    });

    expect(config.plugins.slots?.contextEngine).toBe("pinecone-memory");
  });

  it("Slack チャンネルが有効でトークンあり: channels.slack にプレースホルダを設定する", () => {
    const agentfile = makeMinimalAgentfile({
      channels: { slack: { enabled: true } },
    });

    const config = buildOpenclawConfig({
      agentfile,
      secrets: { SLACK_BOT_TOKEN: "xoxb-token" },
    });

    // 実値ではなくプレースホルダが設定される（release_command で展開）
    expect(config.channels.slack).toMatchObject({
      enabled: true,
      botToken: placeholder("SLACK_BOT_TOKEN"),
    });
    expect(config.plugins.allow).toContain("slack");
  });

  it("Slack signingSecret がある場合もプレースホルダを設定する", () => {
    const agentfile = makeMinimalAgentfile({
      channels: { slack: { enabled: true } },
    });

    const config = buildOpenclawConfig({
      agentfile,
      secrets: { SLACK_BOT_TOKEN: "xoxb-token", SLACK_SIGNING_SECRET: "sign-secret" },
    });

    expect(config.channels.slack).toMatchObject({
      enabled: true,
      botToken: placeholder("SLACK_BOT_TOKEN"),
      signingSecret: placeholder("SLACK_SIGNING_SECRET"),
    });
  });

  it("Slack チャンネルが有効でトークンなし: throw せずプレースホルダで生成（再デプロイ対応）", () => {
    const agentfile = makeMinimalAgentfile({
      channels: { slack: { enabled: true } },
    });

    const config = buildOpenclawConfig({
      agentfile,
      secrets: {},
    });

    expect(config.channels.slack).toMatchObject({
      enabled: true,
      botToken: placeholder("SLACK_BOT_TOKEN"),
    });
  });

  it("Line チャンネルが有効でトークンあり: channels.line にプレースホルダを設定する", () => {
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

    // 実値ではなくプレースホルダが設定される（release_command で展開）
    expect(config.channels.line).toMatchObject({
      enabled: true,
      accessToken: placeholder("LINE_ACCESS_TOKEN"),
      channelSecret: placeholder("LINE_CHANNEL_SECRET"),
    });
    expect(config.plugins.allow).toContain("line");
  });

  it("Line チャンネルが有効でトークンなし: throw せずプレースホルダで生成（再デプロイ対応）", () => {
    const agentfile = makeMinimalAgentfile({
      channels: { line: { enabled: true } },
    });

    const config = buildOpenclawConfig({
      agentfile,
      secrets: {},
    });

    expect(config.channels.line).toMatchObject({
      enabled: true,
      accessToken: placeholder("LINE_ACCESS_TOKEN"),
      channelSecret: placeholder("LINE_CHANNEL_SECRET"),
    });
  });

  it("Line チャンネルが有効で一部トークンのみ: throw せずプレースホルダで生成（再デプロイ対応）", () => {
    const agentfile = makeMinimalAgentfile({
      channels: { line: { enabled: true } },
    });

    const config = buildOpenclawConfig({
      agentfile,
      secrets: { LINE_ACCESS_TOKEN: "token-only" },
    });

    expect(config.channels.line).toMatchObject({
      enabled: true,
      accessToken: placeholder("LINE_ACCESS_TOKEN"),
      channelSecret: placeholder("LINE_CHANNEL_SECRET"),
    });
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

  it("RAG が有効: pinecone-memory エントリが enabled=true かつ config.ragEnabled=true", () => {
    const agentfile = makeMinimalAgentfile({
      config: { rag: { enabled: true } },
    });

    const config = buildOpenclawConfig({
      agentfile,
      secrets: {},
    });

    expect(config.plugins.entries["pinecone-memory"]?.enabled).toBe(true);
    expect(config.plugins.entries["pinecone-memory"]?.config.ragEnabled).toBe(true);
    expect(config.plugins.slots?.contextEngine).toBe("pinecone-memory");
  });

  it("RAG が無効/未指定: pinecone-memory エントリは enabled=true のまま config.ragEnabled=false で制御", () => {
    const agentfile = makeMinimalAgentfile({
      config: { rag: { enabled: false } },
    });

    const config = buildOpenclawConfig({
      agentfile,
      secrets: {},
    });

    // classic mode 互換: エントリ自体は常に有効
    expect(config.plugins.entries["pinecone-memory"]?.enabled).toBe(true);
    // RAG 動作は config.ragEnabled で制御
    expect(config.plugins.entries["pinecone-memory"]?.config.ragEnabled).toBe(false);
    expect(config.plugins.slots?.contextEngine).toBe("lossless-claw");
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

  it("Agentfile の config.env が env に含まれる", () => {
    const agentfile = makeMinimalAgentfile({
      config: { env: { LOG_LEVEL: "info", NODE_ENV: "production" } },
    });

    const config = buildOpenclawConfig({ agentfile, secrets: {} });

    expect(config.env.LOG_LEVEL).toBe("info");
    expect(config.env.NODE_ENV).toBe("production");
  });

  it("Agentfile の env にシークレットキーがあっても env には含めない", () => {
    const agentfile = makeMinimalAgentfile({
      config: { env: { ANTHROPIC_API_KEY: "from-agentfile", LOG_LEVEL: "debug" } },
    });

    const config = buildOpenclawConfig({
      agentfile,
      secrets: { ANTHROPIC_API_KEY: "from-secret" },
    });

    expect(config.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(config.env.LOG_LEVEL).toBe("debug");
  });

  it("tools.builtin に model-router がある場合 plugins.entries に model-router が含まれる", () => {
    const agentfile = makeMinimalAgentfile({
      tools: { builtin: ["model-router"] },
    });

    const config = buildOpenclawConfig({ agentfile, secrets: {} });

    expect(config.plugins.entries["model-router"]?.enabled).toBe(true);
  });

  it("tools.builtin に workflow-controller と model-router がある場合、両方の entries が設定される", () => {
    const agentfile = makeMinimalAgentfile({
      tools: { builtin: ["workflow-controller", "model-router"] },
    });

    const config = buildOpenclawConfig({ agentfile, secrets: {} });

    expect(config.plugins.entries["workflow-controller"]?.enabled).toBe(true);
    expect(config.plugins.entries["model-router"]?.enabled).toBe(true);
  });

  describe("pinecone-memory RAG 設定", () => {
    it("RAG 有効 + agents_core.file + knowledge.config が正しく反映される", () => {
      const agentfile = makeMinimalAgentfile({
        config: { rag: { enabled: true } },
        agents_core: { file: "./AGENTS-CORE.md" },
        knowledge: {
          sources: [],
          config: {
            top_k: 5,
            min_score: 0.8,
            token_budget: 3000,
          },
        },
      });

      const config = buildOpenclawConfig({ agentfile, secrets: { PINECONE_API_KEY: "pk-test" } });

      const pmConfig = config.plugins.entries["pinecone-memory"]?.config;
      expect(config.plugins.entries["pinecone-memory"]?.enabled).toBe(true);
      expect(config.plugins.slots?.contextEngine).toBe("pinecone-memory");
      expect(pmConfig?.ragEnabled).toBe(true);
      expect(pmConfig?.agentId).toBe("test-agent");
      expect(pmConfig?.agentsCorePath).toBe("/app/easyflow/identity/AGENTS-CORE.md");
      expect(pmConfig?.ragTopK).toBe(5);
      expect(pmConfig?.ragMinScore).toBe(0.8);
      expect(pmConfig?.ragTokenBudget).toBe(3000);
      // apiKey は設定ファイルに含めない（process.env.PINECONE_API_KEY から解決）
      expect(pmConfig?.apiKey).toBeUndefined();
    });

    it("agents_core.inline でも agentsCorePath が設定される", () => {
      const agentfile = makeMinimalAgentfile({
        config: { rag: { enabled: true } },
        agents_core: { inline: "You are a core agent." },
      });

      const config = buildOpenclawConfig({ agentfile, secrets: {} });

      const pmConfig = config.plugins.entries["pinecone-memory"]?.config;
      expect(pmConfig?.agentsCorePath).toBe("/app/easyflow/identity/AGENTS-CORE.md");
    });

    it("agents_core がない場合は agentsCorePath が設定されない", () => {
      const agentfile = makeMinimalAgentfile({
        config: { rag: { enabled: true } },
      });

      const config = buildOpenclawConfig({ agentfile, secrets: {} });

      const pmConfig = config.plugins.entries["pinecone-memory"]?.config;
      expect(pmConfig?.agentsCorePath).toBeUndefined();
    });

    it("knowledge.config がない場合はデフォルト値が使用される", () => {
      const agentfile = makeMinimalAgentfile({
        config: { rag: { enabled: true } },
      });

      const config = buildOpenclawConfig({ agentfile, secrets: {} });

      const pmConfig = config.plugins.entries["pinecone-memory"]?.config;
      expect(pmConfig?.ragTopK).toBe(10);
      expect(pmConfig?.ragMinScore).toBe(0.75);
      expect(pmConfig?.ragTokenBudget).toBe(2000);
    });

    it("PINECONE_API_KEY の有無に関わらず apiKey は設定ファイルに含まれない", () => {
      const agentfile = makeMinimalAgentfile({
        config: { rag: { enabled: true } },
      });

      // シークレットあり
      const configWithSecret = buildOpenclawConfig({
        agentfile,
        secrets: { PINECONE_API_KEY: "pk-test" },
      });
      expect(configWithSecret.plugins.entries["pinecone-memory"]?.config?.apiKey).toBeUndefined();

      // シークレットなし
      const configWithoutSecret = buildOpenclawConfig({ agentfile, secrets: {} });
      expect(
        configWithoutSecret.plugins.entries["pinecone-memory"]?.config?.apiKey,
      ).toBeUndefined();
    });

    it("agentId を指定した場合は env と pinecone-memory config に同じ値を設定する", () => {
      const agentfile = makeMinimalAgentfile({
        config: { rag: { enabled: true } },
      });

      const config = buildOpenclawConfig({
        agentfile,
        secrets: {},
        agentId: "my-fly-app",
      });

      expect(config.env.OPENCLAW_AGENT_ID).toBe("my-fly-app");
      expect(config.plugins.entries["pinecone-memory"]?.config.agentId).toBe("my-fly-app");
      expect(config.plugins.slots?.contextEngine).toBe("pinecone-memory");
    });
  });
});
