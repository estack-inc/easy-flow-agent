import type { AnyAgentTool } from "openclaw/plugin-sdk";
import type { WorkflowContextEngine } from "./context-engine.js";
import {
  advanceStep,
  blockStep,
  createWorkflow,
  listWorkflows,
  loadWorkflow,
  renderContextMarkdown,
} from "./store.js";

/**
 * ワークフロー管理ツール群を生成する。
 * AI エージェントがワークフローの作成・進行・ブロック・参照を行えるようにする。
 */
export function createWorkflowTools(params: {
  agentDir: string;
  contextEngine: WorkflowContextEngine;
}): AnyAgentTool[] {
  const { agentDir, contextEngine } = params;

  const workflowCreateTool: AnyAgentTool = {
    name: "workflow_create",
    description:
      "Create a new workflow with named steps. " +
      "Use this when you need to track multi-step tasks with progress, facts, and open questions.",
    parameters: {
      type: "object",
      properties: {
        label: { type: "string", description: "Workflow display name" },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Step identifier (snake_case)" },
              label: { type: "string", description: "Step display name" },
              nextStepId: {
                type: "string",
                description: "Default next step ID (overrides sequential order)",
              },
              conditions: {
                type: "array",
                description: "Conditional branches from this step",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", description: "Condition label (human-readable)" },
                    nextStepId: {
                      type: "string",
                      description: "Target step ID if this condition matches",
                    },
                  },
                  required: ["label", "nextStepId"],
                },
              },
            },
            required: ["id", "label"],
          },
          description: "Ordered list of steps",
        },
        plan: { type: "string", description: "Initial plan (natural language)" },
      },
      required: ["label", "steps"],
    },
    execute: async (_callId: string, args: Record<string, unknown>) => {
      const state = createWorkflow(agentDir, {
        label: args.label as string,
        steps: args.steps as Array<{
          id: string;
          label: string;
          nextStepId?: string;
          conditions?: Array<{ label: string; nextStepId: string }>;
        }>,
        plan: (args.plan as string) ?? "",
      });

      // Activate the new workflow in the context engine
      contextEngine.setActiveWorkflow(state.workflowId);

      return {
        content: [
          {
            type: "text" as const,
            text: `Workflow created: ${state.workflowId}\n\n${renderContextMarkdown(state)}`,
          },
        ],
      };
    },
  };

  const workflowAdvanceTool: AnyAgentTool = {
    name: "workflow_advance",
    description:
      "Mark the current step as completed and advance to the next step. " +
      "Optionally add facts, resolve questions, or update the plan.",
    parameters: {
      type: "object",
      properties: {
        workflowId: { type: "string", description: "Workflow ID" },
        stepId: { type: "string", description: "Step to complete (defaults to current)" },
        newFacts: {
          type: "array",
          items: { type: "string" },
          description: "New facts discovered during this step",
        },
        resolvedQuestions: {
          type: "array",
          items: { type: "string" },
          description: "Questions that have been answered (exact match to remove)",
        },
        newQuestions: {
          type: "array",
          items: { type: "string" },
          description: "New questions that arose during this step",
        },
        planUpdate: { type: "string", description: "Updated plan text (replaces current)" },
      },
      required: ["workflowId"],
    },
    execute: async (_callId: string, args: Record<string, unknown>) => {
      const state = advanceStep(agentDir, {
        workflowId: args.workflowId as string,
        stepId: args.stepId as string | undefined,
        newFacts: args.newFacts as string[] | undefined,
        resolvedQuestions: args.resolvedQuestions as string[] | undefined,
        newQuestions: args.newQuestions as string[] | undefined,
        planUpdate: args.planUpdate as string | undefined,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Step advanced.\n\n${renderContextMarkdown(state)}`,
          },
        ],
      };
    },
  };

  const workflowBlockTool: AnyAgentTool = {
    name: "workflow_block",
    description:
      "Mark a step as blocked with reasons. Use when a step cannot proceed due to missing information or dependencies.",
    parameters: {
      type: "object",
      properties: {
        workflowId: { type: "string", description: "Workflow ID" },
        stepId: { type: "string", description: "Step to block (defaults to current)" },
        reasons: {
          type: "array",
          items: { type: "string" },
          description: "Reasons why the step is blocked",
        },
      },
      required: ["workflowId", "reasons"],
    },
    execute: async (_callId: string, args: Record<string, unknown>) => {
      const state = blockStep(agentDir, {
        workflowId: args.workflowId as string,
        stepId: args.stepId as string | undefined,
        reasons: args.reasons as string[],
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Step blocked.\n\n${renderContextMarkdown(state)}`,
          },
        ],
      };
    },
  };

  const workflowStatusTool: AnyAgentTool = {
    name: "workflow_status",
    description:
      "Get the current status of a workflow, including progress, facts, and open questions.",
    parameters: {
      type: "object",
      properties: {
        workflowId: { type: "string", description: "Workflow ID (omit to list all)" },
      },
    },
    execute: async (_callId: string, args: Record<string, unknown>) => {
      const workflowId = args.workflowId as string | undefined;

      if (!workflowId) {
        const ids = listWorkflows(agentDir);
        if (ids.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No active workflows." }],
          };
        }
        const summaries = ids
          .map((id) => {
            const s = loadWorkflow(agentDir, id);
            if (!s) return null;
            const completed = s.completedStepIds.length;
            return `- **${s.label}** (${id}): ${completed}/${s.steps.length} steps completed`;
          })
          .filter(Boolean);

        return {
          content: [{ type: "text" as const, text: `## Workflows\n\n${summaries.join("\n")}` }],
        };
      }

      const state = loadWorkflow(agentDir, workflowId);
      if (!state) {
        return {
          content: [{ type: "text" as const, text: `Workflow not found: ${workflowId}` }],
        };
      }

      return {
        content: [{ type: "text" as const, text: renderContextMarkdown(state) }],
      };
    },
  };

  const workflowUpdateContextTool: AnyAgentTool = {
    name: "workflow_update_context",
    description:
      "Update facts, open questions, or plan without advancing the step. " +
      "Use for mid-step knowledge updates.",
    parameters: {
      type: "object",
      properties: {
        workflowId: { type: "string", description: "Workflow ID" },
        addFacts: {
          type: "array",
          items: { type: "string" },
          description: "Facts to add",
        },
        removeFacts: {
          type: "array",
          items: { type: "string" },
          description: "Facts to remove (exact match)",
        },
        addQuestions: {
          type: "array",
          items: { type: "string" },
          description: "Open questions to add",
        },
        resolveQuestions: {
          type: "array",
          items: { type: "string" },
          description: "Questions to remove (exact match)",
        },
        plan: { type: "string", description: "Replace current plan" },
      },
      required: ["workflowId"],
    },
    execute: async (_callId: string, args: Record<string, unknown>) => {
      const wfId = args.workflowId as string;
      const state = loadWorkflow(agentDir, wfId);
      if (!state) {
        return {
          content: [{ type: "text" as const, text: `Workflow not found: ${wfId}` }],
        };
      }

      const addFacts = args.addFacts as string[] | undefined;
      const removeFacts = args.removeFacts as string[] | undefined;
      const addQuestions = args.addQuestions as string[] | undefined;
      const resolveQuestions = args.resolveQuestions as string[] | undefined;
      const plan = args.plan as string | undefined;

      if (addFacts) {
        state.facts.push(...addFacts);
      }
      if (removeFacts) {
        const toRemove = new Set(removeFacts);
        state.facts = state.facts.filter((f) => !toRemove.has(f));
      }
      if (addQuestions) {
        state.openQuestions.push(...addQuestions);
      }
      if (resolveQuestions) {
        const toResolve = new Set(resolveQuestions);
        state.openQuestions = state.openQuestions.filter((q) => !toResolve.has(q));
      }
      if (plan !== undefined) {
        state.currentPlan = plan;
      }

      state.updatedAt = Date.now();
      // Re-import saveWorkflow to avoid circular dependency at module level
      const { saveWorkflow } = await import("./store.js");
      saveWorkflow(agentDir, state);

      return {
        content: [
          {
            type: "text" as const,
            text: `Context updated.\n\n${renderContextMarkdown(state)}`,
          },
        ],
      };
    },
  };

  const workflowBranchTool: AnyAgentTool = {
    name: "workflow_branch",
    description:
      "Complete the current step and advance to a specific branch based on a condition label. " +
      "Use when the current step has defined conditions and you need to choose a specific path. " +
      "Example: if step has conditions ['承認が必要', '自動処理'], call with the matching label.",
    parameters: {
      type: "object",
      properties: {
        workflowId: { type: "string", description: "Workflow ID" },
        conditionLabel: {
          type: "string",
          description:
            "The condition label to match (must exactly match one of the step's conditions[].label)",
        },
        stepId: { type: "string", description: "Step to complete (defaults to current)" },
        newFacts: {
          type: "array",
          items: { type: "string" },
          description: "New facts discovered",
        },
        planUpdate: { type: "string", description: "Updated plan text" },
      },
      required: ["workflowId", "conditionLabel"],
    },
    execute: async (_callId: string, args: Record<string, unknown>) => {
      const state = advanceStep(agentDir, {
        workflowId: args.workflowId as string,
        stepId: args.stepId as string | undefined,
        conditionLabel: args.conditionLabel as string,
        newFacts: args.newFacts as string[] | undefined,
        planUpdate: args.planUpdate as string | undefined,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Branched to: ${state.currentStepId}\n\n${renderContextMarkdown(state)}`,
          },
        ],
      };
    },
  };

  return [
    workflowCreateTool,
    workflowAdvanceTool,
    workflowBlockTool,
    workflowStatusTool,
    workflowUpdateContextTool,
    workflowBranchTool,
  ];
}
