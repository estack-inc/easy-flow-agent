function workflowStateToUnified(state) {
  const blockedStep = state.steps.find((s) => s.status === "blocked");
  return {
    workflowId: state.workflowId,
    currentStepId: state.currentStepId,
    completedStepIds: [...state.completedStepIds],
    blockedReasons: blockedStep?.blockedReasons ? [...blockedStep.blockedReasons] : [],
    facts: [...state.facts],
    openQuestions: [...state.openQuestions],
    currentPlan: state.currentPlan
  };
}
function advanceWorkflowStep(state, params) {
  const targetStepId = params.stepId ?? state.currentStepId;
  let nextStepId = targetStepId;
  const updatedSteps = state.steps.map((step) => {
    if (step.id === targetStepId) {
      return {
        ...step,
        status: "completed",
        completedAt: Date.now(),
        blockedReasons: void 0
      };
    }
    return { ...step };
  });
  const completedStep = state.steps.find((s) => s.id === targetStepId);
  const resolvedId = completedStep ? resolveNextStepId(completedStep, params.conditionLabel) : null;
  if (resolvedId) {
    const target = updatedSteps.find((s) => s.id === resolvedId);
    if (!target) {
      throw new Error(`Branch target step not found: ${resolvedId}`);
    }
    target.status = "running";
    nextStepId = target.id;
  } else {
    const nextPending = updatedSteps.find((s) => s.status === "pending");
    if (nextPending) {
      nextPending.status = "running";
      nextStepId = nextPending.id;
    }
  }
  const updatedCompletedIds = state.completedStepIds.includes(targetStepId) ? [...state.completedStepIds] : [...state.completedStepIds, targetStepId];
  let updatedFacts = [...state.facts];
  if (params.newFacts) {
    updatedFacts = [...updatedFacts, ...params.newFacts];
  }
  let updatedQuestions = [...state.openQuestions];
  if (params.resolvedQuestions) {
    const resolved = new Set(params.resolvedQuestions);
    updatedQuestions = updatedQuestions.filter((q) => !resolved.has(q));
  }
  if (params.newQuestions) {
    updatedQuestions = [...updatedQuestions, ...params.newQuestions];
  }
  return {
    ...state,
    currentStepId: nextStepId,
    steps: updatedSteps,
    completedStepIds: updatedCompletedIds,
    facts: updatedFacts,
    openQuestions: updatedQuestions,
    currentPlan: params.planUpdate ?? state.currentPlan,
    updatedAt: Date.now()
  };
}
function blockWorkflowStep(state, params) {
  const targetStepId = params.stepId ?? state.currentStepId;
  const updatedSteps = state.steps.map((step) => {
    if (step.id === targetStepId) {
      return {
        ...step,
        status: "blocked",
        blockedReasons: [...params.reasons]
      };
    }
    return { ...step };
  });
  return {
    ...state,
    steps: updatedSteps,
    updatedAt: Date.now()
  };
}
function resolveNextStepId(step, conditionLabel) {
  if (conditionLabel && step.conditions && step.conditions.length > 0) {
    const matched = step.conditions.find((c) => c.label === conditionLabel);
    if (matched) {
      return matched.nextStepId;
    }
  }
  if (step.nextStepId) {
    return step.nextStepId;
  }
  return null;
}
function getWorkflowSummary(state) {
  const completed = state.completedStepIds.length;
  const total = state.steps.length;
  const currentStep = state.steps.find((s) => s.id === state.currentStepId);
  const currentLabel = currentStep?.label ?? "Unknown";
  const blockedStep = state.steps.find((s) => s.status === "blocked");
  const sections = [];
  sections.push(`## Workflow: ${state.label}`);
  sections.push(`**Progress:** ${completed}/${total} steps completed`);
  sections.push(`**Current:** ${currentLabel}`);
  sections.push(`**Plan:** ${state.currentPlan}`);
  if (state.facts.length > 0) {
    sections.push(`
**Facts:**
${state.facts.map((f) => `- ${f}`).join("\n")}`);
  }
  if (state.openQuestions.length > 0) {
    sections.push(`
**Open Questions:**
${state.openQuestions.map((q) => `- ${q}`).join("\n")}`);
  }
  if (blockedStep?.blockedReasons && blockedStep.blockedReasons.length > 0) {
    sections.push(
      `
**Blocked Reasons:**
${blockedStep.blockedReasons.map((r) => `- ${r}`).join("\n")}`
    );
  }
  return sections.join("\n");
}
export {
  advanceWorkflowStep,
  blockWorkflowStep,
  getWorkflowSummary,
  workflowStateToUnified
};
