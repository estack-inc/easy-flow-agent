function createMockWorkflowState(overrides) {
  return {
    workflowId: "wf-test-001",
    label: "Test Workflow",
    currentStepId: "step-2",
    steps: [
      {
        id: "step-1",
        label: "First Step",
        status: "completed",
        completedAt: Date.now() - 6e4
      },
      {
        id: "step-2",
        label: "Second Step",
        status: "running"
      },
      {
        id: "step-3",
        label: "Third Step",
        status: "pending"
      }
    ],
    completedStepIds: ["step-1"],
    facts: ["Fact 1", "Fact 2"],
    openQuestions: ["Question 1"],
    currentPlan: "Current plan text",
    createdAt: Date.now() - 12e4,
    updatedAt: Date.now(),
    sessionId: "sess-001",
    ...overrides
  };
}
function createMockAgentState(overrides) {
  return {
    completedSteps: ["step-1"],
    facts: ["Agent Fact 1", "Agent Fact 2"],
    currentPlan: "Agent plan",
    openQuestions: ["Agent Question 1"],
    metadata: {
      createdAt: Date.now() - 6e4,
      updatedAt: Date.now(),
      sessionId: "agent-sess-001"
    },
    ...overrides
  };
}
function createMockUnifiedAgentState(overrides) {
  return {
    workflowId: "wf-test-001",
    currentStepId: "step-2",
    completedStepIds: ["step-1"],
    blockedReasons: [],
    facts: ["Fact 1", "Fact 2"],
    openQuestions: ["Question 1"],
    currentPlan: "Current plan text",
    ...overrides
  };
}
export {
  createMockAgentState,
  createMockUnifiedAgentState,
  createMockWorkflowState
};
