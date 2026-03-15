import type { UnifiedAgentState } from "./types.js";

/**
 * Token Optimizer の AgentState 型定義
 *
 * Workflow Controller の WorkflowState と異なるスキーマを持つため、
 * これを UnifiedAgentState に変換する必要がある。
 */
export interface AgentState {
  /** 完了したステップの ID 配列 */
  completedSteps: string[];

  /** 収集した事実・知見 */
  facts: string[];

  /** 現在の計画 */
  currentPlan: string;

  /** 未解決な質問 */
  openQuestions: string[];

  /** メタデータ */
  metadata?: {
    createdAt?: number;
    updatedAt?: number;
    sessionId?: string;
  };
}

/**
 * AgentState → UnifiedAgentState 変換
 *
 * Token Optimizer の AgentState を統合型に変換。
 * Workflow Controller とのデータ交換時に使用。
 */
export function agentStateToUnified(
  agentState: AgentState,
  workflowContext: { workflowId: string; currentStepId: string },
): UnifiedAgentState {
  return {
    workflowId: workflowContext.workflowId,
    currentStepId: workflowContext.currentStepId,
    completedStepIds: [...agentState.completedSteps],
    blockedReasons: [], // Agent レイヤーではブロック理由を持たない
    facts: [...agentState.facts],
    openQuestions: [...agentState.openQuestions],
    currentPlan: agentState.currentPlan,
  };
}

/**
 * UnifiedAgentState → AgentState 逆変換
 *
 * UnifiedAgentState から AgentState を復元。
 * データの往復変換に使用。
 */
export function unifiedToAgentState(unified: UnifiedAgentState): AgentState {
  return {
    completedSteps: [...unified.completedStepIds],
    facts: [...unified.facts],
    currentPlan: unified.currentPlan,
    openQuestions: [...unified.openQuestions],
    metadata: {
      updatedAt: Date.now(),
    },
  };
}

/**
 * AgentState にコンテキストを追加（純粋関数）
 *
 * Token Optimizer が新しい事実や質問を収集した際に
 * AgentState を更新する。元の state は変更しない。
 */
export function updateAgentContext(
  state: AgentState,
  updates: {
    newFacts?: string[];
    newQuestions?: string[];
    resolvedQuestions?: string[];
    planUpdate?: string;
  },
): AgentState {
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
      updatedAt: Date.now(),
    },
  };
}

/**
 * Token Optimizer のコンテキストを Markdown 形式で生成
 *
 * LLM に提示するためのコンテキスト生成。
 */
export function formatAgentContextForLLM(state: AgentState): string {
  const sections: string[] = [];

  sections.push("## Agent Context");

  if (state.currentPlan) {
    sections.push(`**Plan:** ${state.currentPlan}`);
  }

  if (state.facts.length > 0) {
    sections.push(`\n**Collected Facts:**\n${state.facts.map((f) => `- ${f}`).join("\n")}`);
  }

  if (state.openQuestions.length > 0) {
    sections.push(`\n**Open Questions:**\n${state.openQuestions.map((q) => `- ${q}`).join("\n")}`);
  }

  if (state.completedSteps.length > 0) {
    sections.push(`\n**Completed Steps:** ${state.completedSteps.join(", ")}`);
  }

  return sections.join("\n");
}
