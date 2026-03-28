import { PineconeClient } from "@easy-flow/pinecone-client";
import type { OpenClawPluginApi, OpenClawPluginToolFactory } from "openclaw/plugin-sdk/core";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/core";
import os from "node:os";
import path from "node:path";
import { WorkflowContextEngine } from "./src/context-engine.js";
import { createNoopDelegate } from "./src/noop-delegate.js";
import { createWorkflowTools } from "./src/tools.js";
import { loadFlowDefinitions } from "./src/flow-loader.js";

/**
 * Workflow Controller プラグイン（Pinecone ラップ対応版）
 *
 * Pinecone 設定がある場合: WorkflowContextEngine → PineconeContextEngine（長期記憶 + WC制御）
 * Pinecone 設定がない場合: WorkflowContextEngine → NoopDelegate（WC制御のみ）
 *
 * 注意: openclaw 内部モジュール（LegacyContextEngine）はプラグインからは参照不可のため、
 * Pinecone なしの場合はノープOPデリゲートを使用する。
 * Fly.io 環境では PINECONE_API_KEY が常に設定されているため実用上の問題はない。
 */

type PluginConfig = {
  pineconeApiKey?: string;
  agentId?: string;
  indexName?: string;
  compactAfterDays?: number;
};

const workflowControllerPlugin = {
  id: "workflow-controller",
  name: "Workflow Controller",
  description:
    "Step-based workflow execution control with context optimization (facts, questions, plan). Wraps Pinecone as delegate when configured.",
  kind: "context-engine" as const,
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    let sharedEngine: WorkflowContextEngine | undefined;

    // フロー定義の読み込み
    const workflowsDir = path.join(os.homedir(), ".openclaw", "workflows");
    const loadedFlows = loadFlowDefinitions(workflowsDir, api.logger);
    if (loadedFlows.length > 0) {
      api.logger.info(`workflow-controller: ${loadedFlows.length} flow definitions loaded from ${workflowsDir}`);
    } else {
      api.logger.info(`workflow-controller: No external flow definitions found, using built-in fallback`);
    }

    api.registerContextEngine("workflow", async () => {
      const cfg = (api.pluginConfig ?? {}) as PluginConfig;
      const pineconeApiKey = cfg.pineconeApiKey ?? process.env.PINECONE_API_KEY;

      if (pineconeApiKey) {
        const agentId = cfg.agentId ?? process.env.OPENCLAW_AGENT_ID ?? "default";
        const indexName = cfg.indexName ?? "easy-flow-memory";
        const compactAfterDays = cfg.compactAfterDays ?? 7;
        const pineconeClient = new PineconeClient({ apiKey: pineconeApiKey, indexName });

        api.logger.info(
          `workflow-controller: Pinecone delegate enabled (agentId: ${agentId}, index: ${indexName})`,
        );

        sharedEngine = new WorkflowContextEngine({
          delegate: createNoopDelegate(),
          pinecone: { client: pineconeClient, agentId, compactAfterDays },
        });
      } else {
        // Pinecone なし — NoopDelegate を使用（WC制御のみ有効）
        // LegacyContextEngine はプラグインからは参照不可のためこの設計とする
        api.logger.warn(
          "workflow-controller: PINECONE_API_KEY not set — using noop delegate (no long-term memory)",
        );
        sharedEngine = new WorkflowContextEngine({ delegate: createNoopDelegate() });
      }

      return sharedEngine;
    });

    api.registerTool(
      ((ctx) => {
        if (ctx.sandboxed) return null;
        const agentDir = ctx.agentDir;
        if (!agentDir) return null;

        if (sharedEngine) {
          sharedEngine.setAgentDir(agentDir);
          return createWorkflowTools({ agentDir, contextEngine: sharedEngine });
        }

        const standalone = new WorkflowContextEngine({
          delegate: createNoopDelegate(),
          agentDir,
        });
        return createWorkflowTools({ agentDir, contextEngine: standalone });
      }) as OpenClawPluginToolFactory,
      {
        names: [
          "workflow_create",
          "workflow_advance",
          "workflow_block",
          "workflow_status",
          "workflow_update_context",
          "workflow_branch",
        ],
        optional: true,
      },
    );
  },
};

export default workflowControllerPlugin;
