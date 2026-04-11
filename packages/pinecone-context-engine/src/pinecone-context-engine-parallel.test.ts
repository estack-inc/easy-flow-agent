import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IPineconeClient, QueryResult, TextChunk } from "@easy-flow/pinecone-client";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PineconeContextEngineParallel } from "./pinecone-context-engine-parallel.js";

// Mock Pinecone client
const mockPineconeClient: IPineconeClient = {
  ensureIndex: vi.fn().mockResolvedValue({}),
  query: vi.fn(),
  upsert: vi.fn().mockResolvedValue({}),
  delete: vi.fn().mockResolvedValue({}),
};

const mockChunk: TextChunk = {
  text: "Test memory content",
  agentId: "test-agent",
  sourceFile: "test-file",
  sourceType: "memory_file",
};

describe("PineconeContextEngineParallel", () => {
  let engine: PineconeContextEngineParallel;
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    engine = new PineconeContextEngineParallel({
      pineconeClient: mockPineconeClient,
      agentId: "test-agent",
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "parallel-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("assemble - parallel execution", () => {
    it("should return immediately without waiting for Pinecone query", async () => {
      // Setup: Mock slow Pinecone query (500ms delay)
      const mockResults: QueryResult[] = [{ id: "test-1", score: 0.95, chunk: mockChunk }];

      (mockPineconeClient.query as any).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(mockResults), 500)),
      );

      const messages: AgentMessage[] = [
        { id: "1", role: "user", content: "What is the weather today?", timestamp: Date.now() },
      ];

      const startTime = Date.now();
      const result = await engine.assemble({ sessionId: "test-session", messages });
      const endTime = Date.now();
      const elapsed = endTime - startTime;

      // Assert: Should return immediately (< 50ms), not wait for 500ms Pinecone query
      expect(elapsed).toBeLessThan(50);
      expect(result.messages).toEqual(messages);
      expect(result.contextPromise).toBeDefined();
    });

    it("should resolve contextPromise with proper memory content", async () => {
      const mockResults: QueryResult[] = [
        {
          id: "test-1",
          score: 0.85,
          chunk: {
            ...mockChunk,
            text: "Important memory: Easy Flow pricing is 50,000 yen per agent",
          },
        },
      ];
      (mockPineconeClient.query as any).mockResolvedValue(mockResults);

      const messages: AgentMessage[] = [
        { id: "1", role: "user", content: "What is our pricing model?", timestamp: Date.now() },
      ];

      const result = await engine.assemble({ sessionId: "test-session", messages });
      const context = await result.contextPromise!;

      // Assert
      expect(context.systemPromptAddition).toContain("Important memory: Easy Flow pricing");
      expect(context.estimatedTokens).toBeGreaterThan(0);
    });

    it("should handle Pinecone query timeout gracefully", { timeout: 10000 }, async () => {
      // Setup: Mock timeout (longer than 3s timeout)
      (mockPineconeClient.query as any).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve([]), 5000)),
      );

      const messages: AgentMessage[] = [
        { id: "1", role: "user", content: "Test query", timestamp: Date.now() },
      ];

      const result = await engine.assemble({ sessionId: "test-session", messages });
      const context = await result.contextPromise!;

      // Assert: Should fallback gracefully without throwing
      expect(context.systemPromptAddition).toBeUndefined();
      expect(context.estimatedTokens).toBe(0);
    });

    it("should return empty result when no query can be built", async () => {
      const messages: AgentMessage[] = []; // Empty messages
      const result = await engine.assemble({ sessionId: "test-session", messages });

      // Assert
      expect(result.messages).toEqual([]);
      expect(result.estimatedTokens).toBe(0);
      expect(result.contextPromise).toBeUndefined();
    });
  });

  describe("compact", () => {
    function writeSessionFile(
      filePath: string,
      entries: Array<{
        timestamp: number;
        message: { role: string; content: string };
      }>,
    ) {
      const content = entries.map((e) => JSON.stringify(e)).join("\n");
      fs.writeFileSync(filePath, content, "utf-8");
    }

    it("upserts old turns to Pinecone and returns compacted: true", async () => {
      const compactEngine = new PineconeContextEngineParallel({
        pineconeClient: mockPineconeClient,
        agentId: "test-agent",
        compactAfterDays: 7,
      });

      const sessionFile = path.join(tmpDir, "session.jsonl");
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      writeSessionFile(sessionFile, [
        { timestamp: eightDaysAgo, message: { role: "user", content: "old message" } },
        { timestamp: Date.now(), message: { role: "user", content: "recent message" } },
      ]);

      const result = await compactEngine.compact({ sessionId: "s1", sessionFile });

      expect(result.ok).toBe(true);
      expect(result.compacted).toBe(true);
      expect(mockPineconeClient.upsert).toHaveBeenCalledOnce();
    });

    it("returns compacted: false when no old turns exist", async () => {
      const sessionFile = path.join(tmpDir, "session.jsonl");
      writeSessionFile(sessionFile, [
        { timestamp: Date.now(), message: { role: "user", content: "recent" } },
      ]);

      const result = await engine.compact({ sessionId: "s1", sessionFile });

      expect(result.ok).toBe(true);
      expect(result.compacted).toBe(false);
      expect(mockPineconeClient.upsert).not.toHaveBeenCalled();
    });

    it("returns ok: false when upsert fails", async () => {
      (mockPineconeClient.upsert as any).mockRejectedValueOnce(new Error("upsert failed"));

      const compactEngine = new PineconeContextEngineParallel({
        pineconeClient: mockPineconeClient,
        agentId: "test-agent",
        compactAfterDays: 7,
      });

      const sessionFile = path.join(tmpDir, "session.jsonl");
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      writeSessionFile(sessionFile, [
        { timestamp: eightDaysAgo, message: { role: "user", content: "old message" } },
      ]);

      vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await compactEngine.compact({ sessionId: "s1", sessionFile });

      expect(result.ok).toBe(false);
      expect(result.compacted).toBe(false);
    });
  });

  describe("ragEnabled warning", () => {
    it("warns when ragEnabled=true is passed", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      new PineconeContextEngineParallel({
        pineconeClient: mockPineconeClient,
        agentId: "test-agent",
        ragEnabled: true,
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("ragEnabled=true は Parallel 実装では未サポート"),
      );

      warnSpy.mockRestore();
    });

    it("does not warn when ragEnabled is false or omitted", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      new PineconeContextEngineParallel({
        pineconeClient: mockPineconeClient,
        agentId: "test-agent",
        ragEnabled: false,
      });

      new PineconeContextEngineParallel({
        pineconeClient: mockPineconeClient,
        agentId: "test-agent",
      });

      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });
});
