import { bugFlow } from "./bug.js";
import { commandFlow } from "./command.js";
import { consultFlow } from "./consult.js";
import { ideaFlow } from "./idea.js";
import { reportFlow } from "./report.js";
import { taskFlow } from "./task.js";
export * from "./types.js";
import { bugFlow as bugFlow2 } from "./bug.js";
import { commandFlow as commandFlow2 } from "./command.js";
import { consultFlow as consultFlow2 } from "./consult.js";
import { ideaFlow as ideaFlow2 } from "./idea.js";
import { reportFlow as reportFlow2 } from "./report.js";
import { taskFlow as taskFlow2 } from "./task.js";
const flowMap = {
  taskflow_task: taskFlow2,
  taskflow_command: commandFlow2,
  taskflow_consult: consultFlow2,
  taskflow_bug: bugFlow2,
  taskflow_report: reportFlow2,
  taskflow_idea: ideaFlow2
};
function getTaskFlow(flowId) {
  return flowMap[flowId];
}
function listTaskFlows() {
  return Object.values(flowMap);
}
export {
  bugFlow,
  commandFlow,
  consultFlow,
  getTaskFlow,
  ideaFlow,
  listTaskFlows,
  reportFlow,
  taskFlow
};
