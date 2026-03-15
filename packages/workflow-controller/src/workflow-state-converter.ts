import type {
  AdvanceStepParams,
  BlockStepParams,
  UnifiedAgentState,
  WorkflowState,
} from "./types.js";

/**
 * WorkflowState → UnifiedAgentState 変換
 *
 * 内部の詳細型（WorkflowState）から公開インターフェース（UnifiedAgentState）へ
 * の変換。OpenClaw のコンテキスト注入時に使用される。
 * 防御的コピーを行い、元の state とのオブジェクト共有を防ぐ。
 */
export function workflowStateToUnified(state: WorkflowState): UnifiedAgentState {
  const blockedStep = state.steps.find((s) => s.status === "blocked");

  return {
    workflowId: state.workflowId,
    currentStepId: state.currentStepId,
    completedStepIds: [...state.completedStepIds],
    blockedReasons: blockedStep?.blockedReasons ? [...blockedStep.blockedReasons] : [],
    facts: [...state.facts],
    openQuestions: [...state.openQuestions],
    currentPlan: state.currentPlan,
  };
}

/**
 * WorkflowState に進捗を反映する（純粋関数）
 *
 * ステップ完了時に WorkflowState を更新した新しいオブジェクトを返す。
 * 元の state は変更しない（イミュータブル）。
 * completedStepIds を更新し、facts/openQuestions/currentPlan を最新化。
 */
export function advanceWorkflowStep(
  state: WorkflowState,
  params: AdvanceStepParams,
): WorkflowState {
  const targetStepId = params.stepId ?? state.currentStepId;

  // ステップを完了状態にし、次の pending を running にする
  let nextStepId = targetStepId;
  const updatedSteps = state.steps.map((step) => {
    if (step.id === targetStepId) {
      return {
        ...step,
        status: "completed" as const,
        completedAt: Date.now(),
        blockedReasons: undefined,
      };
    }
    return { ...step };
  });

  // 次の pending ステップを見つけて running にする
  const nextPending = updatedSteps.find((s) => s.status === "pending");
  if (nextPending) {
    nextPending.status = "running";
    nextStepId = nextPending.id;
  }

  // completedStepIds に追加（重複排除）
  const updatedCompletedIds = state.completedStepIds.includes(targetStepId)
    ? [...state.completedStepIds]
    : [...state.completedStepIds, targetStepId];

  // facts を更新
  let updatedFacts = [...state.facts];
  if (params.newFacts) {
    updatedFacts = [...updatedFacts, ...params.newFacts];
  }

  // openQuestions を更新
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
    updatedAt: Date.now(),
  };
}

/**
 * ステップをブロック状態に設定（純粋関数）
 *
 * 特定のステップをブロック状態にし、理由を記録。
 * 元の state は変更しない。
 */
export function blockWorkflowStep(state: WorkflowState, params: BlockStepParams): WorkflowState {
  const targetStepId = params.stepId ?? state.currentStepId;

  const updatedSteps = state.steps.map((step) => {
    if (step.id === targetStepId) {
      return {
        ...step,
        status: "blocked" as const,
        blockedReasons: [...params.reasons],
      };
    }
    return { ...step };
  });

  return {
    ...state,
    steps: updatedSteps,
    updatedAt: Date.now(),
  };
}

/**
 * ワークフロー進捗のサマリー生成
 *
 * コンテキスト注入用の人間可読な Markdown サマリーを返す。
 */
export function getWorkflowSummary(state: WorkflowState): string {
  const completed = state.completedStepIds.length;
  const total = state.steps.length;
  const currentStep = state.steps.find((s) => s.id === state.currentStepId);
  const currentLabel = currentStep?.label ?? "Unknown";
  const blockedStep = state.steps.find((s) => s.status === "blocked");

  const sections: string[] = [];

  sections.push(`## Workflow: ${state.label}`);
  sections.push(`**Progress:** ${completed}/${total} steps completed`);
  sections.push(`**Current:** ${currentLabel}`);
  sections.push(`**Plan:** ${state.currentPlan}`);

  if (state.facts.length > 0) {
    sections.push(`\n**Facts:**\n${state.facts.map((f) => `- ${f}`).join("\n")}`);
  }

  if (state.openQuestions.length > 0) {
    sections.push(`\n**Open Questions:**\n${state.openQuestions.map((q) => `- ${q}`).join("\n")}`);
  }

  if (blockedStep?.blockedReasons && blockedStep.blockedReasons.length > 0) {
    sections.push(
      `\n**Blocked Reasons:**\n${blockedStep.blockedReasons.map((r) => `- ${r}`).join("\n")}`,
    );
  }

  return sections.join("\n");
}
