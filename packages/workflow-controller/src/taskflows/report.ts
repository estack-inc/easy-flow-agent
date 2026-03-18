import type { TaskFlowDefinition } from "./types.js";

export const reportFlow: TaskFlowDefinition = {
  flowId: "taskflow_report",
  trigger: "📊",
  description: "状況確認・報告依頼への応答。調査・回答して完了。",
  label: "📊 報告・確認フロー",
  steps: [
    {
      id: "issue_register",
      label: "Issue 登録（ラベル: report）",
    },
    {
      id: "respond",
      label: "確認・調査・回答（Issue + Slack DM に記載）",
    },
    {
      id: "complete",
      label: "よりちかさん確認 → Issue クローズ",
    },
  ],
};
