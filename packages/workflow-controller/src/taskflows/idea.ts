import type { TaskFlowDefinition } from "./types.js";

export const ideaFlow: TaskFlowDefinition = {
  flowId: "taskflow_idea",
  trigger: "💡",
  description: "アイデア・提案を評価して実行可否を判断。実行する場合は taskflow_task を起動。",
  label: "💡 アイデア・提案フロー",
  steps: [
    {
      id: "issue_register",
      label: "Issue 登録（ラベル: idea）",
    },
    {
      id: "evaluation",
      label: "評価（メリット・デメリット・実現難度・推奨度★を提示）",
      conditions: [
        { label: "実行する", nextStepId: "task_spawn" },
        { label: "却下", nextStepId: "close_rejected" },
        { label: "再検討", nextStepId: "evaluation" },
      ],
    },
    {
      id: "task_spawn",
      label: "📋 タスク依頼フローを新規起動",
    },
    {
      id: "close_rejected",
      label: "却下理由を記載 → Issue クローズ",
    },
  ],
};
