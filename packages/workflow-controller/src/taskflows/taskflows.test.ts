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
  "pipeline_implement",
];

describe("TaskFlow definitions", () => {
  it("all 7 flows are registered", () => {
    expect(listTaskFlows()).toHaveLength(7);
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

  it("pipeline_implement has 8 steps with unique ids", () => {
    const flow = getTaskFlow("pipeline_implement");
    expect(flow.steps).toHaveLength(8);
    const ids = flow.steps.map((s) => s.id);
    expect(new Set(ids).size).toBe(8);
  });

  it("pipeline_implement has all required steps", () => {
    const flow = getTaskFlow("pipeline_implement");
    const ids = flow.steps.map((s) => s.id);
    expect(ids).toContain("design_instruction");
    expect(ids).toContain("transfer_instruction");
    expect(ids).toContain("dispatch_agent");
    expect(ids).toContain("wait_implementation");
    expect(ids).toContain("l2_quality_gate");
    expect(ids).toContain("l3_review");
    expect(ids).toContain("l4_approval");
    expect(ids).toContain("close");
  });
});
