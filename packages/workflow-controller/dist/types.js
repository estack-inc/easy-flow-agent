function toUnifiedAgentState(state) {
  const blockedStep = state.steps.find((s) => s.status === "blocked");
  return {
    workflowId: state.workflowId,
    currentStepId: state.currentStepId,
    completedStepIds: [...state.completedStepIds],
    blockedReasons: blockedStep?.blockedReasons ?? [],
    facts: [...state.facts],
    openQuestions: [...state.openQuestions],
    currentPlan: state.currentPlan
  };
}
export {
  toUnifiedAgentState
};
