import type { CreateWorkflowParams } from "../types.js";

export type TaskFlowId =
  | "taskflow_task"
  | "taskflow_command"
  | "taskflow_consult"
  | "taskflow_bug"
  | "taskflow_report"
  | "taskflow_idea";

export type TaskFlowDefinition = CreateWorkflowParams & {
  /** フロー識別子 */
  flowId: TaskFlowId;
  /** フローの説明（メルが選択する際の参照用） */
  description: string;
  /** 起動トリガーとなる Slack アイコン */
  trigger: string;
};
