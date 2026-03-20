function agentStateToUnified(agentState, workflowContext) {
  return {
    workflowId: workflowContext.workflowId,
    currentStepId: workflowContext.currentStepId,
    completedStepIds: [...agentState.completedSteps],
    blockedReasons: [],
    // Agent レイヤーではブロック理由を持たない
    facts: [...agentState.facts],
    openQuestions: [...agentState.openQuestions],
    currentPlan: agentState.currentPlan
  };
}
function unifiedToAgentState(unified) {
  return {
    completedSteps: [...unified.completedStepIds],
    facts: [...unified.facts],
    currentPlan: unified.currentPlan,
    openQuestions: [...unified.openQuestions],
    metadata: {
      updatedAt: Date.now()
    }
  };
}
function updateAgentContext(state, updates) {
  let facts = [...state.facts];
  let questions = [...state.openQuestions];
  if (updates.newFacts) {
    facts = [...facts, ...updates.newFacts];
  }
  if (updates.resolvedQuestions) {
    const resolved = new Set(updates.resolvedQuestions);
    questions = questions.filter((q) => !resolved.has(q));
  }
  if (updates.newQuestions) {
    questions = [...questions, ...updates.newQuestions];
  }
  return {
    completedSteps: [...state.completedSteps],
    facts,
    currentPlan: updates.planUpdate ?? state.currentPlan,
    openQuestions: questions,
    metadata: {
      ...state.metadata,
      updatedAt: Date.now()
    }
  };
}
function formatAgentContextForLLM(state) {
  const sections = [];
  sections.push("## Agent Context");
  if (state.currentPlan) {
    sections.push(`**Plan:** ${state.currentPlan}`);
  }
  if (state.facts.length > 0) {
    sections.push(`
**Collected Facts:**
${state.facts.map((f) => `- ${f}`).join("\n")}`);
  }
  if (state.openQuestions.length > 0) {
    sections.push(`
**Open Questions:**
${state.openQuestions.map((q) => `- ${q}`).join("\n")}`);
  }
  if (state.completedSteps.length > 0) {
    sections.push(`
**Completed Steps:** ${state.completedSteps.join(", ")}`);
  }
  return sections.join("\n");
}
export {
  agentStateToUnified,
  formatAgentContextForLLM,
  unifiedToAgentState,
  updateAgentContext
};
