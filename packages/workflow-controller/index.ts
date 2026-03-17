import type { OpenClawPluginApi, OpenClawPluginToolFactory } from "openclaw/plugin-sdk/core";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { WorkflowContextEngine } from "./src/context-engine.js";
import { createNoopDelegate } from "./src/noop-delegate.js";
import { createWorkflowTools } from "./src/tools.js";

/**
 * Workflow Controller プラグイン
 *
 * ステップベースのワークフロー実行制御と、
 * facts/openQuestions/plan によるコンテキスト最適化を提供する。
 *
 * 統合ポイント:
 * - api.registerTool() — ワークフロー操作ツール群
 * - api.registerContextEngine() — systemPromptAddition 経由でワークフロー状態を注入
 */
const workflowControllerPlugin = {
  id: "workflow-controller",
  name: "Workflow Controller",
  description:
    "Step-based workflow execution control with context optimization (facts, questions, plan)",
  kind: "context-engine" as const,
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    // Shared context engine instance (set up when factory is called)
    let sharedEngine: WorkflowContextEngine | undefined;

    // Register as a context engine (exclusive slot — replaces legacy engine).
    // The factory is called once by resolveContextEngine() during gateway boot.
    api.registerContextEngine("workflow", async () => {
      // Dynamically import LegacyContextEngine from the internal module.
      // This avoids a static dependency on a non-exported class.
      const { LegacyContextEngine } = await import(
        /* webpackIgnore: true */ "../../src/context-engine/legacy.js"
      );
      const delegate = new LegacyContextEngine();

      sharedEngine = new WorkflowContextEngine({ delegate });
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
