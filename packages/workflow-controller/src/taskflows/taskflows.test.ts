import { describe, expect, it } from "vitest";
import { getTaskFlow, listTaskFlows } from "./index.js";
import type { TaskFlowId } from "./types.js";

const FLOW_IDS: TaskFlowId[] = [
  "taskflow_task",
  "taskflow_command",
  "taskflow_consult",
  "taskflow_bug",
  "taskflow_report",
  "taskflow_idea",
];

describe("TaskFlow definitions", () => {
  it("all 6 flows are registered", () => {
    expect(listTaskFlows()).toHaveLength(6);
  });

  it.each(FLOW_IDS)("%s: has required fields", (flowId) => {
    const flow = getTaskFlow(flowId);
    expect(flow.flowId).toBe(flowId);
    expect(flow.label).toBeTruthy();
    expect(flow.trigger).toBeTruthy();
    expect(flow.description).toBeTruthy();
    expect(flow.steps.length).toBeGreaterThan(0);
  });

  it.each(FLOW_IDS)("%s: all steps have id and label", (flowId) => {
    const flow = getTaskFlow(flowId);
    for (const step of flow.steps) {
      expect(step.id).toBeTruthy();
      expect(step.label).toBeTruthy();
    }
  });

  it.each(FLOW_IDS)("%s: condition nextStepIds reference valid step ids", (flowId) => {
    const flow = getTaskFlow(flowId);
    const stepIds = new Set(flow.steps.map((s) => s.id));
    for (const step of flow.steps) {
      if (step.nextStepId) {
        expect(stepIds.has(step.nextStepId)).toBe(true);
      }
      for (const cond of step.conditions ?? []) {
        expect(stepIds.has(cond.nextStepId)).toBe(true);
      }
    }
  });

  it("taskflow_task has all required steps", () => {
    const flow = getTaskFlow("taskflow_task");
    const ids = flow.steps.map((s) => s.id);
    expect(ids).toContain("requirements");
    expect(ids).toContain("issue_register");
    expect(ids).toContain("task_split");
    expect(ids).toContain("execution");
    expect(ids).toContain("review");
    expect(ids).toContain("acceptance");
  });
});
