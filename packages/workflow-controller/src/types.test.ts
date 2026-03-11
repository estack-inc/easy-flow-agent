import { describe, expect, it } from "vitest";
import type { UnifiedAgentState, WorkflowState } from "./types.js";
import { toUnifiedAgentState } from "./types.js";

describe("UnifiedAgentState", () => {
  it("should create valid instance with all required fields", () => {
    const state: UnifiedAgentState = {
      workflowId: "wf-001",
      currentStepId: "step-1",
      completedStepIds: [],
      blockedReasons: [],
      facts: [],
      openQuestions: [],
      currentPlan: "Initial plan",
    };

    expect(state.workflowId).toBe("wf-001");
    expect(state.currentStepId).toBe("step-1");
    expect(state.currentPlan).toBe("Initial plan");
  });

  it("should handle multiple completed steps", () => {
    const state: UnifiedAgentState = {
      workflowId: "wf-001",
      currentStepId: "step-3",
      completedStepIds: ["step-1", "step-2"],
      blockedReasons: [],
      facts: ["Fact 1", "Fact 2"],
      openQuestions: ["Question 1"],
      currentPlan: "Plan text",
    };

    expect(state.completedStepIds).toHaveLength(2);
    expect(state.completedStepIds).toContain("step-1");
    expect(state.completedStepIds).toContain("step-2");
    expect(state.facts).toHaveLength(2);
    expect(state.openQuestions).toHaveLength(1);
  });

  it("should handle blocked state with multiple reasons", () => {
    const state: UnifiedAgentState = {
      workflowId: "wf-001",
      currentStepId: "step-2",
      completedStepIds: ["step-1"],
      blockedReasons: ["Missing parameter", "Waiting for approval"],
      facts: [],
      openQuestions: [],
      currentPlan: "Blocked",
    };

    expect(state.blockedReasons).toHaveLength(2);
    expect(state.blockedReasons[0]).toBe("Missing parameter");
    expect(state.blockedReasons[1]).toBe("Waiting for approval");
  });

  it("should support Markdown in facts", () => {
    const state: UnifiedAgentState = {
      workflowId: "wf-002",
      currentStepId: "step-1",
      completedStepIds: [],
      blockedReasons: [],
      facts: ["**Bold fact**", "- List item\n- Another item", "`code snippet`"],
      openQuestions: [],
      currentPlan: "",
    };

    expect(state.facts[0]).toContain("**Bold fact**");
    expect(state.facts[1]).toContain("- List item");
  });

  it("should be JSON serializable and deserializable", () => {
    const original: UnifiedAgentState = {
      workflowId: "wf-roundtrip",
      currentStepId: "step-2",
      completedStepIds: ["step-1"],
      blockedReasons: [],
      facts: ["fact1"],
      openQuestions: ["q1", "q2"],
      currentPlan: "Roundtrip plan",
    };

    const json = JSON.stringify(original);
    const restored: UnifiedAgentState = JSON.parse(json);

    expect(restored).toEqual(original);
    expect(Array.isArray(restored.completedStepIds)).toBe(true);
    expect(Array.isArray(restored.blockedReasons)).toBe(true);
    expect(Array.isArray(restored.facts)).toBe(true);
    expect(Array.isArray(restored.openQuestions)).toBe(true);
  });
});

describe("toUnifiedAgentState", () => {
  it("extracts UnifiedAgentState from WorkflowState", () => {
    const workflowState: WorkflowState = {
      workflowId: "wf-convert",
      label: "Convert Test",
      currentStepId: "step-2",
      steps: [
        { id: "step-1", label: "Step 1", status: "completed", completedAt: 1000 },
        { id: "step-2", label: "Step 2", status: "running" },
        { id: "step-3", label: "Step 3", status: "pending" },
      ],
      completedStepIds: ["step-1"],
      facts: ["f1"],
      openQuestions: ["q1"],
      currentPlan: "My plan",
      createdAt: 1000,
      updatedAt: 2000,
      sessionId: "session-abc",
    };

    const unified = toUnifiedAgentState(workflowState);

    expect(unified.workflowId).toBe("wf-convert");
    expect(unified.currentStepId).toBe("step-2");
    expect(unified.completedStepIds).toEqual(["step-1"]);
    expect(unified.blockedReasons).toEqual([]);
    expect(unified.facts).toEqual(["f1"]);
    expect(unified.openQuestions).toEqual(["q1"]);
    expect(unified.currentPlan).toBe("My plan");
  });

  it("extracts blockedReasons from blocked step", () => {
    const workflowState: WorkflowState = {
      workflowId: "wf-blocked",
      label: "Blocked Test",
      currentStepId: "step-1",
      steps: [
        {
          id: "step-1",
          label: "Step 1",
          status: "blocked",
          blockedReasons: ["Reason A", "Reason B"],
        },
      ],
      completedStepIds: [],
      facts: [],
      openQuestions: [],
      currentPlan: "",
      createdAt: 1000,
      updatedAt: 2000,
    };

    const unified = toUnifiedAgentState(workflowState);
    expect(unified.blockedReasons).toEqual(["Reason A", "Reason B"]);
  });

  it("returns defensive copies (no shared references)", () => {
    const workflowState: WorkflowState = {
      workflowId: "wf-copy",
      label: "Copy Test",
      currentStepId: "step-1",
      steps: [{ id: "step-1", label: "S1", status: "running" }],
      completedStepIds: ["prev"],
      facts: ["fact"],
      openQuestions: ["q"],
      currentPlan: "plan",
      createdAt: 1000,
      updatedAt: 2000,
    };

    const unified = toUnifiedAgentState(workflowState);

    // Mutating the unified state should not affect the original
    unified.completedStepIds.push("extra");
    unified.facts.push("extra-fact");
    unified.openQuestions.push("extra-q");

    expect(workflowState.completedStepIds).toEqual(["prev"]);
    expect(workflowState.facts).toEqual(["fact"]);
    expect(workflowState.openQuestions).toEqual(["q"]);
  });
});
