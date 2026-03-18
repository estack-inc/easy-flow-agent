import type { TaskFlowDefinition } from "./types.js";

export const consultFlow: TaskFlowDefinition = {
  flowId: "taskflow_consult",
  trigger: "💬",
  description: "相談・質問を受けて検討・回答。タスクに発展する場合は taskflow_task を起動。",
  label: "💬 相談・質問フロー",
  steps: [
    {
      id: "issue_register",
      label: "Issue 登録（ラベル: consultation）",
    },
    {
      id: "analysis",
      label: "検討・複数案提示（推奨度★付き）",
      conditions: [
        { label: "タスクに発展する", nextStepId: "task_spawn" },
        { label: "回答で完結する", nextStepId: "complete" },
      ],
    },
    {
      id: "task_spawn",
      label: "📋 タスク依頼フローを新規起動",
    },
    {
      id: "complete",
      label: "回答完了・Issue クローズ",
    },
  ],
};
