import type { TaskFlowDefinition } from "./types.js";

export const pipelineImplementFlow: TaskFlowDefinition = {
  flowId: "pipeline_implement",
  trigger: "🔧",
  description:
    "ミライ/アクアへの実装委譲パイプライン。指示書作成 → 転送 → 実行 → CI/AIレビュー → L3レビュー → 承認 → マージ",
  label: "🔧 パイプライン実装フロー",
  steps: [
    {
      id: "design_instruction",
      label: "指示書作成（メルが設計・指示書を作成）",
      conditions: [
        { label: "指示書完成", nextStepId: "transfer_instruction" },
        { label: "設計やり直し", nextStepId: "design_instruction" },
      ],
    },
    {
      id: "transfer_instruction",
      label: "指示書転送（fly sftp でミライ/アクアに転送）",
    },
    {
      id: "dispatch_agent",
      label: "実行指示（Webhook でミライ/アクアに送信）",
    },
    {
      id: "wait_implementation",
      label: "実装待ち（ミライ/アクアが Claude Code で実装・PR 作成）",
      conditions: [
        { label: "PR 作成完了", nextStepId: "l2_quality_gate" },
        { label: "実装中断（問題発見）", nextStepId: "design_instruction" },
      ],
    },
    {
      id: "l2_quality_gate",
      label: "L2 品質ゲート（CI テスト + AI レビュー）",
      conditions: [
        { label: "CI パス + AI Approved", nextStepId: "l3_review" },
        { label: "CI 失敗 or CHANGES_REQUESTED", nextStepId: "wait_implementation" },
      ],
    },
    {
      id: "l3_review",
      label: "L3 レビュー（メルが設計意図・クロスリポジトリ整合を確認）",
      conditions: [
        { label: "L3 Approved", nextStepId: "l4_approval" },
        { label: "修正必要", nextStepId: "wait_implementation" },
      ],
    },
    {
      id: "l4_approval",
      label: "L4 承認（よりちかさん最終確認 → マージ）",
      conditions: [
        { label: "マージ完了", nextStepId: "close" },
        { label: "差し戻し", nextStepId: "l3_review" },
      ],
    },
    {
      id: "close",
      label: "完了（Issue クローズ・ラベル整理）",
    },
  ],
};
