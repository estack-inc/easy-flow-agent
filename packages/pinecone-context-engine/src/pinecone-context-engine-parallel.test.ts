import type { IPineconeClient, QueryResult, TextChunk } from "@easy-flow/pinecone-client";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

  beforeEach(() => {
    vi.clearAllMocks();
    engine = new PineconeContextEngineParallel({
      pineconeClient: mockPineconeClient,
      agentId: "test-agent",
    });
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
});
