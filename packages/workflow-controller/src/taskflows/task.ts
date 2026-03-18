import type { TaskFlowDefinition } from "./types.js";

export const taskFlow: TaskFlowDefinition = {
  flowId: "taskflow_task",
  trigger: "📋",
  description: "要件深掘り → 設計 → タスク分割 → 実行 → レビュー → 検収の標準フロー",
  label: "📋 タスク依頼フロー",
  steps: [
    {
      id: "requirements",
      label: "要件深掘り（目的・範囲・完了条件の明確化）",
      conditions: [
        { label: "validator:PASS → よりちかさんOK", nextStepId: "issue_register" },
        { label: "validator:NG → 再深掘り", nextStepId: "requirements" },
      ],
    },
    {
      id: "issue_register",
      label: "GitHub Issue 登録（要件・完了条件を記載）",
      conditions: [
        { label: "設計・調査が必要", nextStepId: "design" },
        { label: "設計不要・即分割", nextStepId: "task_split" },
      ],
    },
    {
      id: "design",
      label: "設計・調査（方針・構成・選択肢を Issue に記載）",
      conditions: [
        { label: "validator:PASS → よりちかさんOK", nextStepId: "task_split" },
        { label: "validator:NG → 再設計", nextStepId: "design" },
      ],
    },
    {
      id: "task_split",
      label: "タスク分割・指示書作成（アトミック基準で分割）",
      conditions: [
        { label: "validator:PASS → よりちかさん実行", nextStepId: "execution" },
        { label: "validator:NG → 再分割", nextStepId: "task_split" },
        { label: "実行不要・完了", nextStepId: "acceptance" },
      ],
    },
    {
      id: "execution",
      label: "よりちかさんが指示書に基づいて実行",
    },
    {
      id: "review",
      label: "output-reviewer が成果物レビュー（要件・設計との整合チェック）",
      conditions: [
        { label: "reviewer:PASS", nextStepId: "acceptance" },
        { label: "reviewer:NG", nextStepId: "execution" },
      ],
    },
    {
      id: "acceptance",
      label: "検収・完了（よりちかさんが最終確認 → Issue クローズ）",
    },
  ],
};
