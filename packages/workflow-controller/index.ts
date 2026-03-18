import { PineconeClient } from "@easy-flow/pinecone-client";
import type { OpenClawPluginApi, OpenClawPluginToolFactory } from "openclaw/plugin-sdk/core";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { WorkflowContextEngine } from "./src/context-engine.js";
import { createNoopDelegate } from "./src/noop-delegate.js";
import { createWorkflowTools } from "./src/tools.js";

/**
 * Workflow Controller プラグイン（Pinecone ラップ対応版）
 *
 * ステップベースのワークフロー実行制御と、
 * facts/openQuestions/plan によるコンテキスト最適化を提供する。
 *
 * Pinecone 設定が存在する場合、WorkflowContextEngine が PineconeContextEngine を
 * delegate としてラップし、長期記憶 + ワークフロー制御を両立する。
 *
 * 統合ポイント:
 * - api.registerTool() — ワークフロー操作ツール群
 * - api.registerContextEngine() — systemPromptAddition 経由でワークフロー状態を注入
 */

type PluginConfig = {
  /** Pinecone API Key（未設定の場合は PINECONE_API_KEY 環境変数を使用） */
  pineconeApiKey?: string;
  /** Pinecone Agent ID（未設定の場合は OPENCLAW_AGENT_ID 環境変数を使用） */
  agentId?: string;
  /** Pinecone Index Name（デフォルト: easy-flow-memory） */
  indexName?: string;
  /** コンパクト実行までの日数（デフォルト: 7） */
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
    // Shared context engine instance (set up when factory is called)
    let sharedEngine: WorkflowContextEngine | undefined;

    // Register as a context engine (exclusive slot — replaces legacy engine).
    // The factory is called once by resolveContextEngine() during gateway boot.
    api.registerContextEngine("workflow", async () => {
      const cfg = (api.pluginConfig ?? {}) as PluginConfig;

      // Pinecone API キーが設定されている場合は PineconeContextEngine を delegate としてラップ
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
          pinecone: {
            client: pineconeClient,
            agentId,
            compactAfterDays,
          },
        });
      } else {
        // Pinecone なし — LegacyContextEngine を delegate として使用
        const { LegacyContextEngine } = await import(
          /* webpackIgnore: true */ "../../src/context-engine/legacy.js"
        );
        const delegate = new LegacyContextEngine();

        api.logger.info("workflow-controller: using LegacyContextEngine as delegate (no Pinecone)");

        sharedEngine = new WorkflowContextEngine({ delegate });
      }

      return sharedEngine;
    });

    // Register workflow tools as a factory (receives per-session context).
    api.registerTool(
      ((ctx) => {
        if (ctx.sandboxed) {
          return null;
        }

        const agentDir = ctx.agentDir;
        if (!agentDir) {
          return null;
        }

        // Update agentDir on the shared engine if available
        if (sharedEngine) {
          sharedEngine.setAgentDir(agentDir);
          return createWorkflowTools({ agentDir, contextEngine: sharedEngine });
        }

        // Engine not yet initialized — create tools with a standalone engine
        // (tools still work for CRUD; context injection activates once the
        //  context engine slot is resolved)
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
