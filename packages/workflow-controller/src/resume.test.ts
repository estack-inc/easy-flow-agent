import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowContextEngine } from "./context-engine.js";
import { closeWorkflow, createWorkflow, findWorkflowByIssue, loadWorkflow } from "./store.js";
import { createWorkflowTools } from "./tools.js";

describe("Issue resume feature", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-resume-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // issueNumber 保存
  // =========================================================================

  describe("issueNumber persistence", () => {
    it("saves issueNumber and issueRepo to JSON", () => {
      const state = createWorkflow(tmpDir, {
        label: "Issue WF",
        steps: [{ id: "s1", label: "Step 1" }],
        issueNumber: 31,
        issueRepo: "estack-inc/mell-workspace",
      });

      const loaded = loadWorkflow(tmpDir, state.workflowId);
      expect(loaded!.issueNumber).toBe(31);
      expect(loaded!.issueRepo).toBe("estack-inc/mell-workspace");
    });

    it("stores undefined when issueNumber is not provided", () => {
      const state = createWorkflow(tmpDir, {
        label: "No Issue WF",
        steps: [{ id: "s1", label: "Step 1" }],
      });

      const loaded = loadWorkflow(tmpDir, state.workflowId);
      expect(loaded!.issueNumber).toBeUndefined();
      expect(loaded!.issueRepo).toBeUndefined();
    });
  });

  // =========================================================================
  // findWorkflowByIssue
  // =========================================================================

  describe("findWorkflowByIssue", () => {
    it("returns the workflow matching issueNumber", () => {
      const created = createWorkflow(tmpDir, {
        label: "Match WF",
        steps: [{ id: "s1", label: "Step 1" }],
        issueNumber: 42,
        issueRepo: "estack-inc/repo",
      });

      const found = findWorkflowByIssue(tmpDir, 42);
      expect(found).not.toBeNull();
      expect(found!.workflowId).toBe(created.workflowId);
    });

    it("returns null for non-existent issueNumber", () => {
      createWorkflow(tmpDir, {
        label: "Other WF",
        steps: [{ id: "s1", label: "Step 1" }],
        issueNumber: 10,
      });

      const found = findWorkflowByIssue(tmpDir, 999);
      expect(found).toBeNull();
    });

    it("returns null when issueRepo does not match", () => {
      createWorkflow(tmpDir, {
        label: "Repo Mismatch",
        steps: [{ id: "s1", label: "Step 1" }],
        issueNumber: 42,
        issueRepo: "estack-inc/repo-a",
      });

      const found = findWorkflowByIssue(tmpDir, 42, "estack-inc/repo-b");
      expect(found).toBeNull();
    });

    it("matches by issueNumber only when issueRepo is not specified", () => {
      const created = createWorkflow(tmpDir, {
        label: "Repo Flexible",
        steps: [{ id: "s1", label: "Step 1" }],
        issueNumber: 42,
        issueRepo: "estack-inc/repo-a",
      });

      const found = findWorkflowByIssue(tmpDir, 42);
      expect(found).not.toBeNull();
      expect(found!.workflowId).toBe(created.workflowId);
    });
  });

  // =========================================================================
  // closeWorkflow
  // =========================================================================

  describe("closeWorkflow", () => {
    it("sets closedAt timestamp", () => {
      const created = createWorkflow(tmpDir, {
        label: "Close WF",
        steps: [{ id: "s1", label: "Step 1" }],
      });

      const closed = closeWorkflow(tmpDir, created.workflowId);
      expect(closed).not.toBeNull();
      expect(closed!.closedAt).toBeTypeOf("number");
      expect(closed!.closedAt).toBeGreaterThan(0);

      // Verify persistence
      const loaded = loadWorkflow(tmpDir, created.workflowId);
      expect(loaded!.closedAt).toBe(closed!.closedAt);
    });
  });

  // =========================================================================
  // workflow_resume ツール
  // =========================================================================

  describe("workflow_resume tool", () => {
    function createToolsWithMock() {
      const mockContextEngine = {
        setActiveWorkflow: vi.fn(),
      } as unknown as WorkflowContextEngine;

      const tools = createWorkflowTools({
        agentDir: tmpDir,
        contextEngine: mockContextEngine,
      });

      const resumeTool = tools.find((t) => t.name === "workflow_resume")!;
      return { resumeTool, mockContextEngine };
    }

    function parseToolResult(result: { content: Array<{ type: string; text: string }> }) {
      return JSON.parse(result.content[0].text);
    }

    it("resumes an open workflow (issueState: open)", async () => {
      const created = createWorkflow(tmpDir, {
        label: "Resume WF",
        steps: [
          { id: "s1", label: "Step 1" },
          { id: "s2", label: "Step 2" },
        ],
        issueNumber: 31,
        issueRepo: "estack-inc/mell-workspace",
      });

      const { resumeTool, mockContextEngine } = createToolsWithMock();
      const result = await resumeTool.execute("call-1", {
        issueNumber: 31,
        issueRepo: "estack-inc/mell-workspace",
        issueState: "open",
      });

      // OpenClaw standard format: { content: [{ type: "text", text: string }] }
      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("Workflow resumed");
      expect(result.content[0].text).toContain(created.workflowId);
      expect(mockContextEngine.setActiveWorkflow).toHaveBeenCalledWith(created.workflowId);
    });

    it("auto-archives when issueState is closed", async () => {
      const created = createWorkflow(tmpDir, {
        label: "Closed Issue WF",
        steps: [{ id: "s1", label: "Step 1" }],
        issueNumber: 50,
      });

      const { resumeTool } = createToolsWithMock();
      const result = await resumeTool.execute("call-2", {
        issueNumber: 50,
        issueState: "closed",
      });

      const parsed = parseToolResult(result);
      expect(parsed.found).toBe(true);
      expect(parsed.archived).toBe(true);
      expect(parsed.workflowId).toBe(created.workflowId);

      // Verify closedAt was persisted
      const loaded = loadWorkflow(tmpDir, created.workflowId);
      expect(loaded!.closedAt).toBeTypeOf("number");
    });

    it("returns archived: true for already-closed workflow", async () => {
      const created = createWorkflow(tmpDir, {
        label: "Already Closed",
        steps: [{ id: "s1", label: "Step 1" }],
        issueNumber: 60,
      });

      closeWorkflow(tmpDir, created.workflowId);

      const { resumeTool } = createToolsWithMock();
      const result = await resumeTool.execute("call-3", {
        issueNumber: 60,
        issueState: "open",
      });

      const parsed = parseToolResult(result);
      expect(parsed.found).toBe(true);
      expect(parsed.archived).toBe(true);
      expect(parsed.workflowId).toBe(created.workflowId);
    });

    it("returns found: false for non-existent issue", async () => {
      const { resumeTool } = createToolsWithMock();
      const result = await resumeTool.execute("call-4", {
        issueNumber: 9999,
      });

      const parsed = parseToolResult(result);
      expect(parsed.found).toBe(false);
    });
  });
});
