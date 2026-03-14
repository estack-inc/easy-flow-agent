import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { WorkflowContextEngine } from "./context-engine.js";
import { createNoopDelegate } from "./noop-delegate.js";
import { createWorkflow } from "./store.js";
import type { IPineconeClient } from "@easy-flow/pinecone-context-engine";

describe("WorkflowContextEngine", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-ctx-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createEngine(opts?: { activeWorkflowId?: string }) {
    return new WorkflowContextEngine({
      delegate: createNoopDelegate(),
      agentDir: tmpDir,
      activeWorkflowId: opts?.activeWorkflowId,
    });
  }

  describe("assemble", () => {
    it("passes through when no active workflow", async () => {
      const engine = createEngine();
      const messages = [{ role: "user" as const, content: "hello" }];

      const result = await engine.assemble({
        sessionId: "test-session",
        messages,
      });

      expect(result.messages).toBe(messages);
      expect(result.systemPromptAddition).toBeUndefined();
    });

    it("injects workflow context as systemPromptAddition", async () => {
      const state = createWorkflow(tmpDir, {
        label: "Test WF",
        steps: [
          { id: "s1", label: "Step 1" },
          { id: "s2", label: "Step 2" },
        ],
        plan: "My plan",
      });

      const engine = createEngine({ activeWorkflowId: state.workflowId });
      const messages = [{ role: "user" as const, content: "hello" }];

      const result = await engine.assemble({
        sessionId: "test-session",
        messages,
      });

      expect(result.systemPromptAddition).toBeTruthy();
      expect(result.systemPromptAddition).toContain("# Active Workflow");
      expect(result.systemPromptAddition).toContain("Test WF");
      expect(result.systemPromptAddition).toContain("Step 1");
      expect(result.systemPromptAddition).toContain("My plan");
    });

    it("appends to existing systemPromptAddition from delegate", async () => {
      // Create a delegate that returns a systemPromptAddition
      const delegate = createNoopDelegate();
      const originalAssemble = delegate.assemble.bind(delegate);
      delegate.assemble = async (params) => {
        const result = await originalAssemble(params);
        return { ...result, systemPromptAddition: "Existing context" };
      };

      const state = createWorkflow(tmpDir, {
        label: "Append Test",
        steps: [{ id: "s1", label: "S1" }],
      });

      const engine = new WorkflowContextEngine({
        delegate,
        agentDir: tmpDir,
        activeWorkflowId: state.workflowId,
      });

      const result = await engine.assemble({
        sessionId: "test",
        messages: [],
      });

      expect(result.systemPromptAddition).toContain("Existing context");
      expect(result.systemPromptAddition).toContain("# Active Workflow");
    });

    it("returns null addition for nonexistent workflow", async () => {
      const engine = createEngine({ activeWorkflowId: "nonexistent-id" });

      const result = await engine.assemble({
        sessionId: "test",
        messages: [],
      });

      expect(result.systemPromptAddition).toBeUndefined();
    });
  });

  describe("setActiveWorkflow", () => {
    it("switches active workflow dynamically", async () => {
      const wf1 = createWorkflow(tmpDir, {
        label: "WF-1",
        steps: [{ id: "s1", label: "S1" }],
      });
      const wf2 = createWorkflow(tmpDir, {
        label: "WF-2",
        steps: [{ id: "s1", label: "S1" }],
      });

      const engine = createEngine({ activeWorkflowId: wf1.workflowId });

      let result = await engine.assemble({ sessionId: "test", messages: [] });
      expect(result.systemPromptAddition).toContain("WF-1");

      engine.setActiveWorkflow(wf2.workflowId);
      result = await engine.assemble({ sessionId: "test", messages: [] });
      expect(result.systemPromptAddition).toContain("WF-2");

      engine.setActiveWorkflow(undefined);
      result = await engine.assemble({ sessionId: "test", messages: [] });
      expect(result.systemPromptAddition).toBeUndefined();
    });
  });

  describe("delegation", () => {
    it("delegates ingest to delegate", async () => {
      const engine = createEngine();
      const result = await engine.ingest({
        sessionId: "test",
        message: { role: "user", content: "hello" },
      });
      expect(result.ingested).toBe(false); // noop delegate
    });

    it("delegates compact to delegate", async () => {
      const engine = createEngine();
      const result = await engine.compact({
        sessionId: "test",
        sessionFile: "/tmp/test.jsonl",
      });
      expect(result.ok).toBe(true);
      expect(result.compacted).toBe(false);
    });
  });

  describe("info", () => {
    it("reports engine metadata", () => {
      const engine = createEngine();
      expect(engine.info.id).toBe("workflow");
      expect(engine.info.name).toBe("Workflow Context Engine");
    });
  });

  describe("pinecone option", () => {
    function createMockPineconeClient(): IPineconeClient & {
      [K in keyof IPineconeClient]: Mock;
    } {
      return {
        upsert: vi.fn().mockResolvedValue(undefined),
        query: vi.fn().mockResolvedValue([]),
        delete: vi.fn().mockResolvedValue(undefined),
        deleteBySource: vi.fn().mockResolvedValue(undefined),
        deleteNamespace: vi.fn().mockResolvedValue(undefined),
        ensureIndex: vi.fn().mockResolvedValue(undefined),
      } as IPineconeClient & { [K in keyof IPineconeClient]: Mock };
    }

    it("uses PineconeContextEngine as delegate when pinecone option is provided", async () => {
      const client = createMockPineconeClient();
      const engine = new WorkflowContextEngine({
        delegate: createNoopDelegate(),
        agentDir: tmpDir,
        pinecone: {
          client,
          agentId: "mell",
        },
      });

      // ingest should delegate to PineconeContextEngine which calls client.upsert
      await engine.ingest({
        sessionId: "s1",
        message: { role: "user", content: "hello pinecone" },
      });

      expect(client.upsert).toHaveBeenCalledOnce();
    });

    it("passes correct agentId to PineconeContextEngine (not agentDir)", async () => {
      const client = createMockPineconeClient();
      const engine = new WorkflowContextEngine({
        delegate: createNoopDelegate(),
        agentDir: "/home/user/.openclaw/agents/mell",
        pinecone: {
          client,
          agentId: "mell",
        },
      });

      await engine.ingest({
        sessionId: "s1",
        message: { role: "user", content: "test" },
      });

      const chunks = client.upsert.mock.calls[0][0];
      expect(chunks[0].metadata.agentId).toBe("mell");
    });
  });
});
