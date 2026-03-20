import {
  advanceStep,
  blockStep,
  closeWorkflow,
  createWorkflow,
  findWorkflowByIssue,
  listWorkflows,
  loadWorkflow,
  renderContextMarkdown
} from "./store.js";
function createWorkflowTools(params) {
  const { agentDir, contextEngine } = params;
  const workflowCreateTool = {
    name: "workflow_create",
    description: "Create a new workflow with named steps. Use this when you need to track multi-step tasks with progress, facts, and open questions.",
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
                description: "Default next step ID (overrides sequential order)"
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
                      description: "Target step ID if this condition matches"
                    }
                  },
                  required: ["label", "nextStepId"]
                }
              }
            },
            required: ["id", "label"]
          },
          description: "Ordered list of steps"
        },
        plan: { type: "string", description: "Initial plan (natural language)" },
        issueNumber: {
          type: "number",
          description: "GitHub Issue number to link with this workflow (for resume/tracking)"
        },
        issueRepo: {
          type: "string",
          description: "GitHub repository in owner/repo format (e.g. estack-inc/mell-workspace)"
        }
      },
      required: ["label", "steps"]
    },
    execute: async (_callId, args) => {
      const state = createWorkflow(agentDir, {
        label: args.label,
        steps: args.steps,
        plan: args.plan ?? "",
        issueNumber: args.issueNumber,
        issueRepo: args.issueRepo
      });
      contextEngine.setActiveWorkflow(state.workflowId);
      return {
        content: [
          {
            type: "text",
            text: `Workflow created: ${state.workflowId}

${renderContextMarkdown(state)}`
          }
        ]
      };
    }
  };
  const workflowAdvanceTool = {
    name: "workflow_advance",
    description: "Mark the current step as completed and advance to the next step. Optionally add facts, resolve questions, or update the plan.",
    parameters: {
      type: "object",
      properties: {
        workflowId: { type: "string", description: "Workflow ID" },
        stepId: { type: "string", description: "Step to complete (defaults to current)" },
        newFacts: {
          type: "array",
          items: { type: "string" },
          description: "New facts discovered during this step"
        },
        resolvedQuestions: {
          type: "array",
          items: { type: "string" },
          description: "Questions that have been answered (exact match to remove)"
        },
        newQuestions: {
          type: "array",
          items: { type: "string" },
          description: "New questions that arose during this step"
        },
        planUpdate: { type: "string", description: "Updated plan text (replaces current)" }
      },
      required: ["workflowId"]
    },
    execute: async (_callId, args) => {
      const state = advanceStep(agentDir, {
        workflowId: args.workflowId,
        stepId: args.stepId,
        newFacts: args.newFacts,
        resolvedQuestions: args.resolvedQuestions,
        newQuestions: args.newQuestions,
        planUpdate: args.planUpdate
      });
      return {
        content: [
          {
            type: "text",
            text: `Step advanced.

${renderContextMarkdown(state)}`
          }
        ]
      };
    }
  };
  const workflowBlockTool = {
    name: "workflow_block",
    description: "Mark a step as blocked with reasons. Use when a step cannot proceed due to missing information or dependencies.",
    parameters: {
      type: "object",
      properties: {
        workflowId: { type: "string", description: "Workflow ID" },
        stepId: { type: "string", description: "Step to block (defaults to current)" },
        reasons: {
          type: "array",
          items: { type: "string" },
          description: "Reasons why the step is blocked"
        }
      },
      required: ["workflowId", "reasons"]
    },
    execute: async (_callId, args) => {
      const state = blockStep(agentDir, {
        workflowId: args.workflowId,
        stepId: args.stepId,
        reasons: args.reasons
      });
      return {
        content: [
          {
            type: "text",
            text: `Step blocked.

${renderContextMarkdown(state)}`
          }
        ]
      };
    }
  };
  const workflowStatusTool = {
    name: "workflow_status",
    description: "Get the current status of a workflow, including progress, facts, and open questions.",
    parameters: {
      type: "object",
      properties: {
        workflowId: { type: "string", description: "Workflow ID (omit to list all)" }
      }
    },
    execute: async (_callId, args) => {
      const workflowId = args.workflowId;
      if (!workflowId) {
        const ids = listWorkflows(agentDir);
        if (ids.length === 0) {
          return {
            content: [{ type: "text", text: "No active workflows." }]
          };
        }
        const summaries = ids.map((id) => {
          const s = loadWorkflow(agentDir, id);
          if (!s) return null;
          const completed = s.completedStepIds.length;
          return `- **${s.label}** (${id}): ${completed}/${s.steps.length} steps completed`;
        }).filter(Boolean);
        return {
          content: [{ type: "text", text: `## Workflows

${summaries.join("\n")}` }]
        };
      }
      const state = loadWorkflow(agentDir, workflowId);
      if (!state) {
        return {
          content: [{ type: "text", text: `Workflow not found: ${workflowId}` }]
        };
      }
      return {
        content: [{ type: "text", text: renderContextMarkdown(state) }]
      };
    }
  };
  const workflowUpdateContextTool = {
    name: "workflow_update_context",
    description: "Update facts, open questions, or plan without advancing the step. Use for mid-step knowledge updates.",
    parameters: {
      type: "object",
      properties: {
        workflowId: { type: "string", description: "Workflow ID" },
        addFacts: {
          type: "array",
          items: { type: "string" },
          description: "Facts to add"
        },
        removeFacts: {
          type: "array",
          items: { type: "string" },
          description: "Facts to remove (exact match)"
        },
        addQuestions: {
          type: "array",
          items: { type: "string" },
          description: "Open questions to add"
        },
        resolveQuestions: {
          type: "array",
          items: { type: "string" },
          description: "Questions to remove (exact match)"
        },
        plan: { type: "string", description: "Replace current plan" }
      },
      required: ["workflowId"]
    },
    execute: async (_callId, args) => {
      const wfId = args.workflowId;
      const state = loadWorkflow(agentDir, wfId);
      if (!state) {
        return {
          content: [{ type: "text", text: `Workflow not found: ${wfId}` }]
        };
      }
      const addFacts = args.addFacts;
      const removeFacts = args.removeFacts;
      const addQuestions = args.addQuestions;
      const resolveQuestions = args.resolveQuestions;
      const plan = args.plan;
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
      if (plan !== void 0) {
        state.currentPlan = plan;
      }
      state.updatedAt = Date.now();
      const { saveWorkflow } = await import("./store.js");
      saveWorkflow(agentDir, state);
      return {
        content: [
          {
            type: "text",
            text: `Context updated.

${renderContextMarkdown(state)}`
          }
        ]
      };
    }
  };
  const workflowBranchTool = {
    name: "workflow_branch",
    description: "Complete the current step and advance to a specific branch based on a condition label. Use when the current step has defined conditions and you need to choose a specific path. Example: if step has conditions ['\u627F\u8A8D\u304C\u5FC5\u8981', '\u81EA\u52D5\u51E6\u7406'], call with the matching label.",
    parameters: {
      type: "object",
      properties: {
        workflowId: { type: "string", description: "Workflow ID" },
        conditionLabel: {
          type: "string",
          description: "The condition label to match (must exactly match one of the step's conditions[].label)"
        },
        stepId: { type: "string", description: "Step to complete (defaults to current)" },
        newFacts: {
          type: "array",
          items: { type: "string" },
          description: "New facts discovered"
        },
        planUpdate: { type: "string", description: "Updated plan text" }
      },
      required: ["workflowId", "conditionLabel"]
    },
    execute: async (_callId, args) => {
      const state = advanceStep(agentDir, {
        workflowId: args.workflowId,
        stepId: args.stepId,
        conditionLabel: args.conditionLabel,
        newFacts: args.newFacts,
        planUpdate: args.planUpdate
      });
      return {
        content: [
          {
            type: "text",
            text: `Branched to: ${state.currentStepId}

${renderContextMarkdown(state)}`
          }
        ]
      };
    }
  };
  const workflowResumeTool = {
    name: "workflow_resume",
    description: "Resume a previously interrupted workflow by GitHub Issue number. IMPORTANT: Before calling this, check the Issue state with: `gh issue view <issueNumber> -R <repo> --json state -q .state` and pass the result as issueState.",
    parameters: {
      type: "object",
      properties: {
        issueNumber: {
          type: "number",
          description: "GitHub Issue number linked to the workflow"
        },
        issueRepo: {
          type: "string",
          description: "GitHub repository in owner/repo format (e.g. estack-inc/mell-workspace)"
        },
        issueState: {
          type: "string",
          enum: ["open", "closed"],
          description: "Current state of the GitHub Issue. Check via gh CLI before calling this tool."
        }
      },
      required: ["issueNumber"]
    },
    execute: async (_callId, args) => {
      const issueNumber = args.issueNumber;
      const issueRepo = args.issueRepo;
      const issueState = args.issueState ?? "open";
      const state = findWorkflowByIssue(agentDir, issueNumber, issueRepo);
      if (!state) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                found: false,
                message: `Issue #${issueNumber} \u306B\u7D10\u3065\u304F\u30EF\u30FC\u30AF\u30D5\u30ED\u30FC\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093`
              })
            }
          ]
        };
      }
      if (state.closedAt) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                found: true,
                archived: true,
                workflowId: state.workflowId,
                message: `Issue #${issueNumber} \u306E\u30EF\u30FC\u30AF\u30D5\u30ED\u30FC\u306F\u3059\u3067\u306B\u30AF\u30ED\u30FC\u30BA\u6E08\u307F\u3067\u3059\uFF08${new Date(state.closedAt).toISOString()}\uFF09`
              })
            }
          ]
        };
      }
      if (issueState === "closed") {
        closeWorkflow(agentDir, state.workflowId);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                found: true,
                archived: true,
                workflowId: state.workflowId,
                message: `Issue #${issueNumber} \u304C\u30AF\u30ED\u30FC\u30BA\u3055\u308C\u3066\u3044\u308B\u305F\u3081\u3001\u30EF\u30FC\u30AF\u30D5\u30ED\u30FC\u3092\u81EA\u52D5\u30A2\u30FC\u30AB\u30A4\u30D6\u3057\u307E\u3057\u305F`
              })
            }
          ]
        };
      }
      contextEngine.setActiveWorkflow(state.workflowId);
      return {
        content: [
          {
            type: "text",
            text: `Workflow resumed: ${state.workflowId}

${renderContextMarkdown(state)}`
          }
        ]
      };
    }
  };
  return [
    workflowCreateTool,
    workflowAdvanceTool,
    workflowBlockTool,
    workflowStatusTool,
    workflowUpdateContextTool,
    workflowBranchTool,
    workflowResumeTool
  ];
}
export {
  createWorkflowTools
};
