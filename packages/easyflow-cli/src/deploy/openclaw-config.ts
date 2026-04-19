import * as crypto from "node:crypto";
import type { Agentfile } from "../agentfile/types.js";

export interface OpenclawConfigInput {
  agentfile: Agentfile;
  secrets: Record<string, string>;
  agentId?: string;
}

export interface OpenclawConfig {
  env: Record<string, string>;
  channels: Record<string, unknown>;
  plugins: {
    allow: string[];
    load?: { paths?: string[] };
    slots?: Record<string, string>;
    entries: Record<string, { enabled: boolean; config: Record<string, unknown> }>;
    installs?: Record<string, unknown>;
  };
  webchat?: Record<string, unknown>;
  gateway: {
    controlUi: { enabled: boolean };
    auth: { mode: "token"; token: string };
  };
  tools?: Record<string, unknown>;
  agents: Record<string, unknown>;
  session: Record<string, unknown>;
}

/**
 * Agentfile とシークレットから openclaw.json 相当の設定を生成する。
 */
export function buildOpenclawConfig(input: OpenclawConfigInput): OpenclawConfig {
  const { agentfile, secrets } = input;

  // ---- gateway token ----
  const gatewayToken = secrets.GATEWAY_TOKEN ?? crypto.randomBytes(24).toString("hex");

  // ---- env ----
  // Agentfile の config.env のみを含める。
  // シークレット（ANTHROPIC_API_KEY 等）は Fly secrets 経由で process.env に注入され、
  // 各プラグインが process.env から参照するため、ここには埋め込まない。
  const env: Record<string, string> = { ...(agentfile.config?.env ?? {}) };

  // ---- channels ----
  const channels: Record<string, unknown> = {};

  const slackEnabled = agentfile.channels?.slack?.enabled === true;
  if (slackEnabled) {
    // 実値ではなくプレースホルダを埋め込む（release_command で node スクリプトが展開）
    // secret-file 欠落時も Fly secrets 上に存在する前提で再デプロイを許可
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 意図的なプレースホルダ（runtime で展開）
    const slackBotTokenPlaceholder = "${SLACK_BOT_TOKEN}";
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 意図的なプレースホルダ（runtime で展開）
    const slackSigningSecretPlaceholder = "${SLACK_SIGNING_SECRET}";
    channels.slack = {
      enabled: true,
      botToken: slackBotTokenPlaceholder,
      signingSecret: slackSigningSecretPlaceholder,
    };
  }

  const lineEnabled = agentfile.channels?.line?.enabled === true;
  if (lineEnabled) {
    // 実値ではなくプレースホルダを埋め込む（release_command で node スクリプトが展開）
    // secret-file 欠落時も Fly secrets 上に存在する前提で再デプロイを許可
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 意図的なプレースホルダ（runtime で展開）
    const lineAccessTokenPlaceholder = "${LINE_ACCESS_TOKEN}";
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 意図的なプレースホルダ（runtime で展開）
    const lineChannelSecretPlaceholder = "${LINE_CHANNEL_SECRET}";
    channels.line = {
      enabled: true,
      accessToken: lineAccessTokenPlaceholder,
      channelSecret: lineChannelSecretPlaceholder,
    };
  }

  const webchatEnabled = agentfile.channels?.webchat?.enabled === true;
  if (webchatEnabled) {
    channels.webchat = {
      enabled: true,
      ...(agentfile.channels?.webchat && "invite_codes" in agentfile.channels.webchat
        ? { inviteCodes: agentfile.channels.webchat.invite_codes ?? [] }
        : {}),
    };
  }

  // ---- plugins ----
  const allow: string[] = ["easyflow-gateway"];
  if (webchatEnabled) {
    allow.push("easy-flow-webchat");
  }

  const builtinTools = agentfile.tools?.builtin ?? [];
  const pluginEntries: Record<string, { enabled: boolean; config: Record<string, unknown> }> = {};

  if (builtinTools.includes("workflow-controller")) {
    pluginEntries["workflow-controller"] = { enabled: true, config: {} };
  }
  if (builtinTools.includes("file-serve")) {
    pluginEntries["file-serve"] = { enabled: true, config: {} };
  }
  if (builtinTools.includes("model-router")) {
    pluginEntries["model-router"] = { enabled: true, config: {} };
  }

  // pinecone-memory
  const ragEnabled = agentfile.config?.rag?.enabled === true;
  const ragConfig = agentfile.knowledge?.config ?? {};
  const hasAgentsCore =
    agentfile.agents_core?.file != null || agentfile.agents_core?.inline != null;

  const pineconeConfig: Record<string, unknown> = {
    ragEnabled,
    ragTopK: ragConfig.top_k ?? 10,
    ragMinScore: ragConfig.min_score ?? 0.75,
    ragTokenBudget: ragConfig.token_budget ?? 2000,
  };
  if (hasAgentsCore) {
    pineconeConfig.agentsCorePath = "/app/easyflow/identity/AGENTS-CORE.md";
  }
  // apiKey は Fly secrets 経由で process.env.PINECONE_API_KEY に注入され、
  // pinecone-memory プラグインが env から参照するため、設定ファイルには埋め込まない。

  pluginEntries["pinecone-memory"] = { enabled: true, config: pineconeConfig };

  // ---- tools ----
  // apiKey は Fly secrets 経由で process.env.GEMINI_API_KEY に注入され、
  // media プラグインが env から参照するため、設定ファイルには埋め込まない。
  const tools: Record<string, unknown> = {};
  if (secrets.GEMINI_API_KEY) {
    tools.media = { enabled: true };
  }

  // ---- agents ----
  const modelConfig = agentfile.config?.model ?? {};
  const agents: Record<string, unknown> = {
    default: {
      model: modelConfig.default ?? "claude-sonnet-4-5",
      ...(modelConfig.thinking ? { thinkingModel: modelConfig.thinking } : {}),
    },
  };

  // ---- session ----
  const session: Record<string, unknown> = {
    storage: { type: "file", path: "/data/sessions" },
  };

  // ---- webchat section ----
  let webchat: Record<string, unknown> | undefined;
  if (webchatEnabled) {
    webchat = {
      enabled: true,
    };
  }

  const config: OpenclawConfig = {
    env,
    channels,
    plugins: {
      allow,
      entries: pluginEntries,
    },
    gateway: {
      controlUi: { enabled: false },
      auth: { mode: "token", token: gatewayToken },
    },
    agents,
    session,
  };

  if (Object.keys(tools).length > 0) {
    config.tools = tools;
  }

  if (webchat) {
    config.webchat = webchat;
  }

  return config;
}
