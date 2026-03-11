import { describe, expect, it } from "vitest";
import type { WorkflowState } from "./types.js";
import {
  workflowStateToUnified,
  advanceWorkflowStep,
  blockWorkflowStep,
  getWorkflowSummary,
} from "./workflow-state-converter.js";

/** テスト用の WorkflowState ファクトリ */
function createTestState(overrides?: Partial<WorkflowState>): WorkflowState {
  return {
    workflowId: "wf-test",
    label: "Test Workflow",
    currentStepId: "step-1",
    steps: [
      { id: "step-1", label: "Step 1", status: "running" },
      { id: "step-2", label: "Step 2", status: "pending" },
      { id: "step-3", label: "Step 3", status: "pending" },
    ],
    completedStepIds: [],
    facts: [],
    openQuestions: [],
    currentPlan: "Initial plan",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

// =============================================================================
// workflowStateToUnified
// =============================================================================

describe("workflowStateToUnified", () => {
  it("converts WorkflowState to UnifiedAgentState", () => {
    const state = createTestState({
      facts: ["fact-1"],
      openQuestions: ["q-1"],
    });

    const unified = workflowStateToUnified(state);

    expect(unified.workflowId).toBe("wf-test");
    expect(unified.currentStepId).toBe("step-1");
    expect(unified.completedStepIds).toEqual([]);
    expect(unified.blockedReasons).toEqual([]);
    expect(unified.facts).toEqual(["fact-1"]);
    expect(unified.openQuestions).toEqual(["q-1"]);
    expect(unified.currentPlan).toBe("Initial plan");
  });

  it("extracts blockedReasons from blocked step", () => {
    const state = createTestState({
      steps: [
        { id: "step-1", label: "Step 1", status: "blocked", blockedReasons: ["A", "B"] },
        { id: "step-2", label: "Step 2", status: "pending" },
      ],
    });

    const unified = workflowStateToUnified(state);
    expect(unified.blockedReasons).toEqual(["A", "B"]);
  });

  it("returns empty blockedReasons when no step is blocked", () => {
    const state = createTestState();
    const unified = workflowStateToUnified(state);
    expect(unified.blockedReasons).toEqual([]);
  });

  it("creates defensive copies (no shared references)", () => {
    const state = createTestState({
      completedStepIds: ["prev"],
      facts: ["fact"],
      openQuestions: ["q"],
    });

    const unified = workflowStateToUnified(state);

    unified.completedStepIds.push("mutated");
    unified.facts.push("mutated");
    unified.openQuestions.push("mutated");

    expect(state.completedStepIds).toEqual(["prev"]);
    expect(state.facts).toEqual(["fact"]);
    expect(state.openQuestions).toEqual(["q"]);
  });

  it("defensively copies blockedReasons", () => {
    const reasons = ["reason-1"];
    const state = createTestState({
      steps: [{ id: "step-1", label: "S1", status: "blocked", blockedReasons: reasons }],
    });

    const unified = workflowStateToUnified(state);
    unified.blockedReasons.push("mutated");

    expect(reasons).toEqual(["reason-1"]);
  });
});

// =============================================================================
// advanceWorkflowStep
// =============================================================================

describe("advanceWorkflowStep", () => {
  it("completes current step and advances to next", () => {
    const state = createTestState();

    const advanced = advanceWorkflowStep(state, { workflowId: "wf-test" });

    expect(advanced.completedStepIds).toContain("step-1");
    expect(advanced.currentStepId).toBe("step-2");
    expect(advanced.steps[0].status).toBe("completed");
    expect(advanced.steps[0].completedAt).toBeGreaterThan(0);
    expect(advanced.steps[1].status).toBe("running");
    expect(advanced.steps[2].status).toBe("pending");
  });

  it("completes a specific step by stepId", () => {
    const state = createTestState();

    const advanced = advanceWorkflowStep(state, {
      workflowId: "wf-test",
      stepId: "step-1",
    });

    expect(advanced.completedStepIds).toEqual(["step-1"]);
    expect(advanced.currentStepId).toBe("step-2");
  });

  it("adds new facts and questions", () => {
    const state = createTestState({ facts: ["existing"] });

    const advanced = advanceWorkflowStep(state, {
      workflowId: "wf-test",
      newFacts: ["new-fact"],
      newQuestions: ["new-q"],
    });

    expect(advanced.facts).toEqual(["existing", "new-fact"]);
    expect(advanced.openQuestions).toEqual(["new-q"]);
  });

  it("resolves questions", () => {
    const state = createTestState({
      openQuestions: ["q1", "q2", "q3"],
    });

    const advanced = advanceWorkflowStep(state, {
      workflowId: "wf-test",
      resolvedQuestions: ["q1", "q3"],
    });

    expect(advanced.openQuestions).toEqual(["q2"]);
  });

  it("updates plan when provided", () => {
    const state = createTestState();

    const advanced = advanceWorkflowStep(state, {
      workflowId: "wf-test",
      planUpdate: "New plan",
    });

    expect(advanced.currentPlan).toBe("New plan");
  });

  it("preserves plan when planUpdate is not provided", () => {
    const state = createTestState({ currentPlan: "Keep this" });

    const advanced = advanceWorkflowStep(state, { workflowId: "wf-test" });

    expect(advanced.currentPlan).toBe("Keep this");
  });

  it("does not duplicate completedStepIds", () => {
    const state = createTestState({ completedStepIds: ["step-1"] });

    const advanced = advanceWorkflowStep(state, {
      workflowId: "wf-test",
      stepId: "step-1",
    });

    expect(advanced.completedStepIds).toEqual(["step-1"]);
  });

  it("is immutable — does not modify original state", () => {
    const state = createTestState({ facts: ["original"] });

    const advanced = advanceWorkflowStep(state, {
      workflowId: "wf-test",
      newFacts: ["added"],
    });

    expect(state.facts).toEqual(["original"]);
    expect(state.steps[0].status).toBe("running");
    expect(advanced.facts).toEqual(["original", "added"]);
    expect(advanced.steps[0].status).toBe("completed");
  });

  it("clears blockedReasons when completing a blocked step", () => {
    const state = createTestState({
      steps: [
        { id: "step-1", label: "S1", status: "blocked", blockedReasons: ["reason"] },
        { id: "step-2", label: "S2", status: "pending" },
      ],
    });

    const advanced = advanceWorkflowStep(state, { workflowId: "wf-test" });

    expect(advanced.steps[0].status).toBe("completed");
    expect(advanced.steps[0].blockedReasons).toBeUndefined();
  });

  it("keeps currentStepId when no pending step remains", () => {
    const state = createTestState({
      steps: [{ id: "step-1", label: "S1", status: "running" }],
    });

    const advanced = advanceWorkflowStep(state, { workflowId: "wf-test" });

    // No next pending step — stays on the completed step
    expect(advanced.currentStepId).toBe("step-1");
    expect(advanced.completedStepIds).toEqual(["step-1"]);
  });
});

// =============================================================================
// blockWorkflowStep
// =============================================================================

describe("blockWorkflowStep", () => {
  it("blocks current step with reasons", () => {
    const state = createTestState();

    const blocked = blockWorkflowStep(state, {
      workflowId: "wf-test",
      reasons: ["Missing data", "Needs approval"],
    });

    expect(blocked.steps[0].status).toBe("blocked");
    expect(blocked.steps[0].blockedReasons).toEqual(["Missing data", "Needs approval"]);
  });

  it("blocks a specific step by stepId", () => {
    const state = createTestState();

    const blocked = blockWorkflowStep(state, {
      workflowId: "wf-test",
      stepId: "step-2",
      reasons: ["Dependency unmet"],
    });

    expect(blocked.steps[0].status).toBe("running"); // unchanged
    expect(blocked.steps[1].status).toBe("blocked");
    expect(blocked.steps[1].blockedReasons).toEqual(["Dependency unmet"]);
  });

  it("is immutable — does not modify original state", () => {
    const state = createTestState();

    const blocked = blockWorkflowStep(state, {
      workflowId: "wf-test",
      reasons: ["reason"],
    });

    expect(state.steps[0].status).toBe("running");
    expect(blocked.steps[0].status).toBe("blocked");
  });

  it("creates defensive copy of reasons", () => {
    const reasons = ["mutable-reason"];
    const state = createTestState();

    const blocked = blockWorkflowStep(state, {
      workflowId: "wf-test",
      reasons,
    });

    reasons.push("added-later");
    expect(blocked.steps[0].blockedReasons).toEqual(["mutable-reason"]);
  });

  it("updates updatedAt timestamp", () => {
    const state = createTestState({ updatedAt: 1000 });

    const blocked = blockWorkflowStep(state, {
      workflowId: "wf-test",
      reasons: ["reason"],
    });

    expect(blocked.updatedAt).toBeGreaterThan(1000);
  });
});

// =============================================================================
// getWorkflowSummary
// =============================================================================

describe("getWorkflowSummary", () => {
  it("generates summary with progress info", () => {
    const state = createTestState();

    const summary = getWorkflowSummary(state);

    expect(summary).toContain("## Workflow: Test Workflow");
    expect(summary).toContain("**Progress:** 0/3 steps completed");
    expect(summary).toContain("**Current:** Step 1");
    expect(summary).toContain("**Plan:** Initial plan");
  });

  it("includes facts when present", () => {
    const state = createTestState({ facts: ["Fact A", "Fact B"] });

    const summary = getWorkflowSummary(state);

    expect(summary).toContain("**Facts:**");
    expect(summary).toContain("- Fact A");
    expect(summary).toContain("- Fact B");
  });

  it("includes open questions when present", () => {
    const state = createTestState({ openQuestions: ["Why?", "How?"] });

    const summary = getWorkflowSummary(state);

    expect(summary).toContain("**Open Questions:**");
    expect(summary).toContain("- Why?");
    expect(summary).toContain("- How?");
  });

  it("includes blocked reasons when a step is blocked", () => {
    const state = createTestState({
      steps: [
        { id: "step-1", label: "S1", status: "blocked", blockedReasons: ["Blocked!"] },
      ],
    });

    const summary = getWorkflowSummary(state);

    expect(summary).toContain("**Blocked Reasons:**");
    expect(summary).toContain("- Blocked!");
  });

  it("omits sections when empty", () => {
    const state = createTestState();

    const summary = getWorkflowSummary(state);

    expect(summary).not.toContain("**Facts:**");
    expect(summary).not.toContain("**Open Questions:**");
    expect(summary).not.toContain("**Blocked Reasons:**");
  });

  it("reflects completed progress correctly", () => {
    const state = createTestState({
      completedStepIds: ["step-1", "step-2"],
      currentStepId: "step-3",
      steps: [
        { id: "step-1", label: "S1", status: "completed", completedAt: 1000 },
        { id: "step-2", label: "S2", status: "completed", completedAt: 2000 },
        { id: "step-3", label: "S3", status: "running" },
      ],
    });

    const summary = getWorkflowSummary(state);

    expect(summary).toContain("**Progress:** 2/3 steps completed");
    expect(summary).toContain("**Current:** S3");
  });
});
