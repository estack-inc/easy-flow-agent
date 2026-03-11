/**
 * Workflow Controller × Token Optimizer の統合状態管理型定義
 *
 * 設計方針:
 * - OpenClaw の SessionEntry とは分離し、プラグイン独自ストレージで管理
 * - JSON 永続化に完全対応（Set 不使用）
 * - ContextEngine.assemble() の systemPromptAddition 経由でコンテキスト注入
 */

// =============================================================================
// UnifiedAgentState — 統合型状態スキーマ（Issue #71）
// =============================================================================

/**
 * Workflow Controller × Token Optimizer 統合状態型
 *
 * Workflow 制御層（段階的実行）と Token Optimizer 層（コンテキスト最適化）
 * の両方の責務を統一管理するための型スキーマ。
 *
 * - WorkflowState はプラグイン内部の永続化向け（ステップ詳細・メタデータ含む）
 * - UnifiedAgentState は外部公開向けの簡潔なインターフェース
 */
export interface UnifiedAgentState {
  // ===== Workflow 制御層（段階的実行制御） =====

  /** ワークフロー識別子 */
  workflowId: string;

  /** 現在実行中のステップ ID */
  currentStepId: string;

  /**
   * 完了済みステップの ID 集合
   *
   * 注：Set<string> ではなく string[] を使用
   * 理由：JSON 永続化互換性のため
   * ランタイムで必要に応じて Set に変換
   */
  completedStepIds: string[];

  /**
   * 現在のステップがブロックされている理由
   * 複数の理由がある場合は配列で保持
   */
  blockedReasons: string[];

  // ===== Token Optimizer 層（コンテキスト最適化） =====

  /**
   * 収集した事実・情報のリスト
   * Markdown 形式を含む可能性あり
   */
  facts: string[];

  /**
   * 未解決な質問・不明な点のリスト
   * AI が次のステップで確認が必要な項目
   */
  openQuestions: string[];

  /** 現在の計画（自然言語テキスト） */
  currentPlan: string;
}

/**
 * WorkflowState から UnifiedAgentState を抽出する。
 * 内部の詳細型から公開インターフェースへの変換に使用。
 */
export function toUnifiedAgentState(state: WorkflowState): UnifiedAgentState {
  const blockedStep = state.steps.find((s) => s.status === "blocked");
  return {
    workflowId: state.workflowId,
    currentStepId: state.currentStepId,
    completedStepIds: [...state.completedStepIds],
    blockedReasons: blockedStep?.blockedReasons ?? [],
    facts: [...state.facts],
    openQuestions: [...state.openQuestions],
    currentPlan: state.currentPlan,
  };
}

// =============================================================================
// 内部型定義
// =============================================================================

/** ワークフローのステップ状態 */
export type WorkflowStepStatus = "pending" | "running" | "completed" | "blocked" | "skipped";

/** 個別ステップの定義 */
export type WorkflowStep = {
  id: string;
  label: string;
  status: WorkflowStepStatus;
  /** ブロックされている場合の理由 */
  blockedReasons?: string[];
  /** 完了時のタイムスタンプ */
  completedAt?: number;
};

/** ワークフロー全体の状態 */
export type WorkflowState = {
  /** ワークフロー識別子 */
  workflowId: string;
  /** ワークフローの表示名 */
  label: string;
  /** 現在実行中のステップ ID */
  currentStepId: string;
  /** 全ステップの定義と状態 */
  steps: WorkflowStep[];
  /** 完了済みステップ ID の配列（JSON 互換） */
  completedStepIds: string[];

  // === Token Optimizer 層 ===
  /** 収集した事実・情報 */
  facts: string[];
  /** 未解決な質問 */
  openQuestions: string[];
  /** 現在の計画（自然言語テキスト） */
  currentPlan: string;

  // === メタデータ ===
  /** 作成日時 */
  createdAt: number;
  /** 最終更新日時 */
  updatedAt: number;
  /** 対応する OpenClaw セッション ID */
  sessionId?: string;
};

/** ワークフロー作成パラメータ */
export type CreateWorkflowParams = {
  label: string;
  steps: Array<{ id: string; label: string }>;
  plan?: string;
  sessionId?: string;
};

/** ステップ進行パラメータ */
export type AdvanceStepParams = {
  workflowId: string;
  /** 完了するステップ ID（省略時は currentStepId） */
  stepId?: string;
  /** 収集した事実を追加 */
  newFacts?: string[];
  /** 解決した質問を除去 */
  resolvedQuestions?: string[];
  /** 新たな未解決質問を追加 */
  newQuestions?: string[];
  /** 計画の更新 */
  planUpdate?: string;
};

/** ステップブロックパラメータ */
export type BlockStepParams = {
  workflowId: string;
  stepId?: string;
  reasons: string[];
};

/** ワークフロー状態の要約（コンテキスト注入用） */
export type WorkflowContextSummary = {
  workflowId: string;
  label: string;
  currentStep: string;
  progress: string;
  plan: string;
  facts: string[];
  openQuestions: string[];
  blockedReasons: string[];
};
