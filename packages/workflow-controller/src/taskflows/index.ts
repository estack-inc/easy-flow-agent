export { bugFlow } from "./bug.js";
export { commandFlow } from "./command.js";
export { consultFlow } from "./consult.js";
export { ideaFlow } from "./idea.js";
export { pipelineImplementFlow } from "./pipeline.js";
export { reportFlow } from "./report.js";
export { taskFlow } from "./task.js";
export * from "./types.js";

import { bugFlow } from "./bug.js";
import { commandFlow } from "./command.js";
import { consultFlow } from "./consult.js";
import { ideaFlow } from "./idea.js";
import { pipelineImplementFlow } from "./pipeline.js";
import { reportFlow } from "./report.js";
import { taskFlow } from "./task.js";
import type { TaskFlowDefinition, TaskFlowId } from "./types.js";

const flowMap: Record<TaskFlowId, TaskFlowDefinition> = {
  taskflow_task: taskFlow,
  taskflow_command: commandFlow,
  taskflow_consult: consultFlow,
  taskflow_bug: bugFlow,
  taskflow_report: reportFlow,
  taskflow_idea: ideaFlow,
  pipeline_implement: pipelineImplementFlow,
};

/**
 * フロー ID からフロー定義を取得する。
 * メルがフロー起動時に使用。
 */
export function getTaskFlow(flowId: TaskFlowId): TaskFlowDefinition {
  return flowMap[flowId];
}

/** 全フロー定義の一覧を返す */
export function listTaskFlows(): TaskFlowDefinition[] {
  return Object.values(flowMap);
}
