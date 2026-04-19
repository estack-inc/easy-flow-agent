import * as crypto from "node:crypto";
import type { Agentfile } from "../agentfile/types.js";
import { EasyflowError } from "../utils/errors.js";

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
  // Agentfile の config.env をベースに、シークレット whitelist を上書きする
  const env: Record<string, string> = { ...(agentfile.config?.env ?? {}) };
  const secretEnvKeys = [
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "OPENAI_API_KEY",
    "PINECONE_API_KEY",
  ] as const;
  for (const key of secretEnvKeys) {
    if (secrets[key]) {
      env[key] = secrets[key];
    }
  }

  // ---- channels ----
  const channels: Record<string, unknown> = {};

  const slackEnabled = agentfile.channels?.slack?.enabled === true;
  if (slackEnabled) {
    if (!secrets.SLACK_BOT_TOKEN) {
      throw new EasyflowError(
        "SLACK_BOT_TOKEN が設定されていません",
        "Slack チャンネルが有効ですが、SLACK_BOT_TOKEN がシークレットファイルにありません",
        "--secret-file でトークンを含むファイルを指定してください",
      );
    }
    channels.slack = {
      enabled: true,
      botToken: secrets.SLACK_BOT_TOKEN,
      ...(secrets.SLACK_SIGNING_SECRET ? { signingSecret: secrets.SLACK_SIGNING_SECRET } : {}),
    };
  }

  const lineEnabled = agentfile.channels?.line?.enabled === true;
  if (lineEnabled) {
    if (!secrets.LINE_ACCESS_TOKEN || !secrets.LINE_CHANNEL_SECRET) {
      throw new EasyflowError(
        "LINE トークンが不足しています",
        "Line チャンネルが有効ですが、LINE_ACCESS_TOKEN または LINE_CHANNEL_SECRET がシークレットファイルにありません",
        "--secret-file でトークンを含むファイルを指定してください",
      );
    }
    channels.line = {
      enabled: true,
      accessToken: secrets.LINE_ACCESS_TOKEN,
      channelSecret: secrets.LINE_CHANNEL_SECRET,
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
  if (secrets.PINECONE_API_KEY) {
    pineconeConfig.apiKey = secrets.PINECONE_API_KEY;
  }

  pluginEntries["pinecone-memory"] = { enabled: ragEnabled, config: pineconeConfig };

  // ---- tools ----
  const tools: Record<string, unknown> = {};
  if (secrets.GEMINI_API_KEY) {
    tools.media = { enabled: true, apiKey: secrets.GEMINI_API_KEY };
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
