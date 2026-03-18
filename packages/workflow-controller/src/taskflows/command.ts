import type { TaskFlowDefinition } from "./types.js";

export const commandFlow: TaskFlowDefinition = {
  flowId: "taskflow_command",
  trigger: "📢",
  description: "最優先・即実行。バリデーションは task_split のみ。",
  label: "📢 指示・命令フロー",
  steps: [
    {
      id: "issue_register",
      label: "Issue 登録（優先度・期限を記載）",
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
      label: "完了報告（Issue クローズ）",
    },
  ],
};
