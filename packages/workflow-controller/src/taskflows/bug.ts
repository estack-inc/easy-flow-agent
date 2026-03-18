import type { TaskFlowDefinition } from "./types.js";

export const bugFlow: TaskFlowDefinition = {
  flowId: "taskflow_bug",
  trigger: "🐛",
  description: "バグ・業務上の問題・障害・クレームに対応する汎用フロー。",
  label: "🐛 バグ・問題報告フロー",
  steps: [
    {
      id: "issue_register",
      label: "Issue 登録 + 問題レポート作成（テンプレート使用）",
    },
    {
      id: "investigate",
      label: "原因調査・分析（分析テンプレートに沿って記録）",
    },
    {
      id: "triage",
      label: "トリアージ（影響範囲・対応案をよりちかさんに提示）",
      conditions: [
        { label: "対応する", nextStepId: "task_split" },
        { label: "対応しない", nextStepId: "close_no_fix" },
        { label: "再調査", nextStepId: "investigate" },
      ],
    },
    {
      id: "task_split",
      label: "指示書作成（アトミック基準 / task-validator チェック）",
      conditions: [
        { label: "validator:PASS", nextStepId: "execution" },
        { label: "validator:NG", nextStepId: "task_split" },
      ],
    },
    {
      id: "execution",
      label: "よりちかさんが実行",
    },
    {
      id: "review",
      label: "output-reviewer が成果物レビュー",
      conditions: [
        { label: "reviewer:PASS", nextStepId: "complete" },
        { label: "reviewer:NG", nextStepId: "execution" },
      ],
    },
    {
      id: "complete",
      label: "修正完了・Issue クローズ",
      nextStepId: "complete",
    },
    {
      id: "close_no_fix",
      label: "対応不要の理由を記載 → Issue クローズ",
      nextStepId: "close_no_fix",
    },
  ],
};
