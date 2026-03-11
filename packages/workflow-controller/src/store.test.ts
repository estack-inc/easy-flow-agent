import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWorkflow,
  loadWorkflow,
  advanceStep,
  blockStep,
  listWorkflows,
  buildContextSummary,
  renderContextMarkdown,
  saveWorkflow,
} from "./store.js";
import type { WorkflowState } from "./types.js";

describe("workflow store", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("createWorkflow", () => {
    it("creates a workflow with steps", () => {
      const state = createWorkflow(tmpDir, {
        label: "Test Workflow",
        steps: [
          { id: "step1", label: "Step 1" },
          { id: "step2", label: "Step 2" },
          { id: "step3", label: "Step 3" },
        ],
        plan: "Do things in order",
      });

      expect(state.workflowId).toBeTruthy();
      expect(state.label).toBe("Test Workflow");
      expect(state.currentStepId).toBe("step1");
      expect(state.steps).toHaveLength(3);
      expect(state.steps[0].status).toBe("running");
      expect(state.steps[1].status).toBe("pending");
      expect(state.steps[2].status).toBe("pending");
      expect(state.completedStepIds).toEqual([]);
      expect(state.currentPlan).toBe("Do things in order");
    });

    it("persists to disk", () => {
      const state = createWorkflow(tmpDir, {
        label: "Persist Test",
        steps: [{ id: "s1", label: "Only Step" }],
      });

      const loaded = loadWorkflow(tmpDir, state.workflowId);
      expect(loaded).not.toBeNull();
      expect(loaded!.label).toBe("Persist Test");
      expect(loaded!.workflowId).toBe(state.workflowId);
    });

    it("throws when no steps provided", () => {
      expect(() =>
        createWorkflow(tmpDir, { label: "Empty", steps: [] }),
      ).toThrow("at least one step");
    });
  });

  describe("advanceStep", () => {
    it("completes current step and advances to next", () => {
      const initial = createWorkflow(tmpDir, {
        label: "Advance Test",
        steps: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
      });

      const after = advanceStep(tmpDir, {
        workflowId: initial.workflowId,
        newFacts: ["Fact 1"],
        newQuestions: ["Q1"],
      });

      expect(after.currentStepId).toBe("b");
      expect(after.completedStepIds).toEqual(["a"]);
      expect(after.steps[0].status).toBe("completed");
      expect(after.steps[0].completedAt).toBeTruthy();
      expect(after.steps[1].status).toBe("running");
      expect(after.facts).toEqual(["Fact 1"]);
      expect(after.openQuestions).toEqual(["Q1"]);
    });

    it("resolves questions when advancing", () => {
      const initial = createWorkflow(tmpDir, {
        label: "Q Test",
        steps: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
      });

      // Add questions first
      const withQ = advanceStep(tmpDir, {
        workflowId: initial.workflowId,
        newQuestions: ["Q1", "Q2", "Q3"],
      });
      expect(withQ.openQuestions).toEqual(["Q1", "Q2", "Q3"]);

      // Resolve some
      const after = advanceStep(tmpDir, {
        workflowId: initial.workflowId,
        resolvedQuestions: ["Q1", "Q3"],
      });
      expect(after.openQuestions).toEqual(["Q2"]);
    });

    it("throws for unknown workflow", () => {
      expect(() =>
        advanceStep(tmpDir, { workflowId: "nonexistent" }),
      ).toThrow("not found");
    });
  });

  describe("blockStep", () => {
    it("marks current step as blocked", () => {
      const initial = createWorkflow(tmpDir, {
        label: "Block Test",
        steps: [{ id: "s1", label: "S1" }],
      });

      const after = blockStep(tmpDir, {
        workflowId: initial.workflowId,
        reasons: ["Missing API key", "Needs approval"],
      });

      expect(after.steps[0].status).toBe("blocked");
      expect(after.steps[0].blockedReasons).toEqual([
        "Missing API key",
        "Needs approval",
      ]);
    });
  });

  describe("listWorkflows", () => {
    it("lists all workflows", () => {
      createWorkflow(tmpDir, {
        label: "WF1",
        steps: [{ id: "s1", label: "S1" }],
      });
      createWorkflow(tmpDir, {
        label: "WF2",
        steps: [{ id: "s1", label: "S1" }],
      });

      const ids = listWorkflows(tmpDir);
      expect(ids).toHaveLength(2);
    });

    it("returns empty for nonexistent dir", () => {
      expect(listWorkflows("/tmp/nonexistent-workflow-dir")).toEqual([]);
    });
  });

  describe("buildContextSummary", () => {
    it("generates summary from state", () => {
      const state = createWorkflow(tmpDir, {
        label: "Summary Test",
        steps: [
          { id: "a", label: "First" },
          { id: "b", label: "Second" },
        ],
        plan: "My plan",
      });

      const summary = buildContextSummary(state);
      expect(summary.label).toBe("Summary Test");
      expect(summary.progress).toBe("0/2 steps completed");
      expect(summary.currentStep).toBe("First (a)");
      expect(summary.plan).toBe("My plan");
    });
  });

  describe("renderContextMarkdown", () => {
    it("renders markdown with all sections", () => {
      const state = createWorkflow(tmpDir, {
        label: "Render Test",
        steps: [
          { id: "a", label: "Step A" },
          { id: "b", label: "Step B" },
        ],
        plan: "Execute plan",
      });

      // Add some context
      state.facts = ["Fact 1", "Fact 2"];
      state.openQuestions = ["Why?"];
      saveWorkflow(tmpDir, state);

      const md = renderContextMarkdown(state);
      expect(md).toContain("## Workflow: Render Test");
      expect(md).toContain("Step A");
      expect(md).toContain("Step B");
      expect(md).toContain("Fact 1");
      expect(md).toContain("Why?");
      expect(md).toContain("Execute plan");
      expect(md).toContain("[>] Step A"); // running
      expect(md).toContain("[ ] Step B"); // pending
    });
  });

  describe("JSON serialization roundtrip", () => {
    it("survives JSON.stringify/parse without data loss", () => {
      const state = createWorkflow(tmpDir, {
        label: "Roundtrip",
        steps: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        plan: "Plan text",
      });

      state.facts = ["fact1"];
      state.openQuestions = ["q1"];
      saveWorkflow(tmpDir, state);

      const loaded = loadWorkflow(tmpDir, state.workflowId)!;
      expect(loaded.workflowId).toBe(state.workflowId);
      expect(loaded.facts).toEqual(["fact1"]);
      expect(loaded.openQuestions).toEqual(["q1"]);
      expect(loaded.completedStepIds).toEqual([]);
      expect(Array.isArray(loaded.completedStepIds)).toBe(true);
    });
  });
});
