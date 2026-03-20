import { PineconeClient } from "@easy-flow/pinecone-client";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { WorkflowContextEngine } from "./context-engine.js";
import { createNoopDelegate } from "./noop-delegate.js";
import { createWorkflowTools } from "./tools.js";
const workflowControllerPlugin = {
  id: "workflow-controller",
  name: "Workflow Controller",
  description: "Step-based workflow execution control with context optimization (facts, questions, plan). Wraps Pinecone as delegate when configured.",
  kind: "context-engine",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    let sharedEngine;
    api.registerContextEngine("workflow", async () => {
      const cfg = api.pluginConfig ?? {};
      const pineconeApiKey = cfg.pineconeApiKey ?? process.env.PINECONE_API_KEY;
      if (pineconeApiKey) {
        const agentId = cfg.agentId ?? process.env.OPENCLAW_AGENT_ID ?? "default";
        const indexName = cfg.indexName ?? "easy-flow-memory";
        const compactAfterDays = cfg.compactAfterDays ?? 7;
        const pineconeClient = new PineconeClient({ apiKey: pineconeApiKey, indexName });
        api.logger.info(
          `workflow-controller: Pinecone delegate enabled (agentId: ${agentId}, index: ${indexName})`
        );
        sharedEngine = new WorkflowContextEngine({
          delegate: createNoopDelegate(),
          pinecone: { client: pineconeClient, agentId, compactAfterDays }
        });
      } else {
        api.logger.warn(
          "workflow-controller: PINECONE_API_KEY not set \u2014 using noop delegate (no long-term memory)"
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
          agentDir
        });
        return createWorkflowTools({ agentDir, contextEngine: standalone });
      }),
      {
        names: [
          "workflow_create",
          "workflow_advance",
          "workflow_block",
          "workflow_status",
          "workflow_update_context",
          "workflow_branch"
        ],
        optional: true
      }
    );
  }
};
var index_default = workflowControllerPlugin;
export {
  index_default as default
};
