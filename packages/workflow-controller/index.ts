import { PineconeClient } from "@easy-flow/pinecone-client";
import { LegacyContextEngine } from "@mariozechner/pi-agent-core/context-engine";
import type { OpenClawPluginApi, OpenClawPluginToolFactory } from "openclaw/plugin-sdk/core";
import { WorkflowContextEngine } from "./src/context-engine.js";
import { createNoopDelegate } from "./src/noop-delegate.js";
import { createWorkflowTools } from "./src/tools.js";

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
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      pineconeApiKey: { type: "string" as const },
      agentId: { type: "string" as const },
      indexName: { type: "string" as const },
      compactAfterDays: { type: "number" as const, minimum: 1, maximum: 90 },
    },
  },

  register(api: OpenClawPluginApi) {
    let sharedEngine: WorkflowContextEngine | undefined;

    api.registerContextEngine("workflow", async () => {
      const cfg = (api.pluginConfig ?? {}) as PluginConfig;
      const pineconeApiKey = cfg.pineconeApiKey ?? process.env.PINECONE_API_KEY;

      if (pineconeApiKey) {
        const agentId = cfg.agentId ?? process.env.OPENCLAW_AGENT_ID ?? "default";
        const indexName = cfg.indexName ?? "easy-flow-memory";
        const compactAfterDays = cfg.compactAfterDays ?? 7;

        api.logger.info(
          `workflow-controller: Pinecone delegate enabled (agentId: ${agentId}, index: ${indexName})`,
        );

        const pineconeClient = new PineconeClient({
          apiKey: pineconeApiKey,
          indexName,
        });

        sharedEngine = new WorkflowContextEngine({
          delegate: createNoopDelegate(),
          pinecone: { client: pineconeClient, agentId, compactAfterDays },
        });
      } else {
        const delegate = new LegacyContextEngine();
        api.logger.info("workflow-controller: using LegacyContextEngine as delegate (no Pinecone)");
        sharedEngine = new WorkflowContextEngine({ delegate });
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
