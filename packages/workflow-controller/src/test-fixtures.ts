import type { WorkflowState, UnifiedAgentState } from "./types.js";
import type { AgentState } from "./agent-state-converter.js";

/**
 * テスト用の WorkflowState モックデータ生成
 */
export function createMockWorkflowState(overrides?: Partial<WorkflowState>): WorkflowState {
  return {
    workflowId: "wf-test-001",
    label: "Test Workflow",
    currentStepId: "step-2",
    steps: [
      {
        id: "step-1",
        label: "First Step",
        status: "completed",
        completedAt: Date.now() - 60000,
      },
      {
        id: "step-2",
        label: "Second Step",
        status: "running",
      },
      {
        id: "step-3",
        label: "Third Step",
        status: "pending",
      },
    ],
    completedStepIds: ["step-1"],
    facts: ["Fact 1", "Fact 2"],
    openQuestions: ["Question 1"],
    currentPlan: "Current plan text",
    createdAt: Date.now() - 120000,
    updatedAt: Date.now(),
    sessionId: "sess-001",
    ...overrides,
  };
}

/**
 * テスト用の AgentState モックデータ生成
 */
export function createMockAgentState(overrides?: Partial<AgentState>): AgentState {
  return {
    completedSteps: ["step-1"],
    facts: ["Agent Fact 1", "Agent Fact 2"],
    currentPlan: "Agent plan",
    openQuestions: ["Agent Question 1"],
    metadata: {
      createdAt: Date.now() - 60000,
      updatedAt: Date.now(),
      sessionId: "agent-sess-001",
    },
    ...overrides,
  };
}

/**
 * テスト用の UnifiedAgentState モックデータ生成
 */
export function createMockUnifiedAgentState(
  overrides?: Partial<UnifiedAgentState>,
): UnifiedAgentState {
  return {
    workflowId: "wf-test-001",
    currentStepId: "step-2",
    completedStepIds: ["step-1"],
    blockedReasons: [],
    facts: ["Fact 1", "Fact 2"],
    openQuestions: ["Question 1"],
    currentPlan: "Current plan text",
    ...overrides,
  };
}
