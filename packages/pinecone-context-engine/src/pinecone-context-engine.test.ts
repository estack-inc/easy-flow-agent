import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MemoryChunk, QueryParams, QueryResult } from "@easy-flow/pinecone-client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { PineconeContextEngine, isQueryThin, buildEnrichedQuery } from "./pinecone-context-engine.js";
import { estimateTokens } from "./token-estimator.js";
import type { IPineconeClient } from "./types.js";

function createMockClient(
  overrides?: Partial<IPineconeClient>,
): IPineconeClient & { [K in keyof IPineconeClient]: Mock } {
  return {
    upsert: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteBySource: vi.fn().mockResolvedValue(undefined),
    deleteNamespace: vi.fn().mockResolvedValue(undefined),
    ensureIndex: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as IPineconeClient & { [K in keyof IPineconeClient]: Mock };
}

function createMockFallback() {
  return {
    info: { id: "mock-fallback", name: "Mock Fallback", version: "0.0.1" },
    ingest: vi.fn().mockResolvedValue({ ingested: false }),
    assemble: vi.fn().mockResolvedValue({
      messages: [],
      estimatedTokens: 0,
      systemPromptAddition: "fallback content",
    }),
    compact: vi.fn().mockResolvedValue({ ok: true, compacted: false }),
  };
}

describe("PineconeContextEngine", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pce-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("info", () => {
    it("reports engine metadata", () => {
      const engine = new PineconeContextEngine({
        pineconeClient: createMockClient(),
        agentId: "test-agent",
      });
      expect(engine.info.id).toBe("pinecone");
      expect(engine.info.name).toBe("Pinecone Context Engine");
      expect(engine.info.version).toBe("1.0.0");
    });
  });

  describe("bootstrap", () => {
    it("calls ensureIndex and returns bootstrapped: true", async () => {
      const client = createMockClient();
      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
      });

      const result = await engine.bootstrap({
        sessionId: "s1",
        sessionFile: "/tmp/s1.jsonl",
      });

      expect(client.ensureIndex).toHaveBeenCalledOnce();
      expect(result.bootstrapped).toBe(true);
    });

    it("returns bootstrapped: false on non-429 error (does not throw)", async () => {
      const client = createMockClient();
      client.ensureIndex.mockRejectedValue(new Error("connection refused"));

      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
      });

      vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await engine.bootstrap({
        sessionId: "s1",
        sessionFile: "/tmp/s1.jsonl",
      });

      expect(result.bootstrapped).toBe(false);
      expect(result.reason).toContain("connection refused");
    });

    it("retries on 429 rate limit", async () => {
      const client = createMockClient();
      const rateLimitError = Object.assign(new Error("Rate limited"), {
        status: 429,
      });
      client.ensureIndex.mockRejectedValueOnce(rateLimitError).mockResolvedValueOnce(undefined);

      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
      });

      const result = await engine.bootstrap({
        sessionId: "s1",
        sessionFile: "/tmp/s1.jsonl",
      });

      expect(client.ensureIndex).toHaveBeenCalledTimes(2);
      expect(result.bootstrapped).toBe(true);
    });
  });

  describe("ingest", () => {
    it("ingests user messages", async () => {
      const client = createMockClient();
      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
      });

      const result = await engine.ingest({
        sessionId: "s1",
        message: { role: "user", content: "Hello, world!" },
      });

      expect(result.ingested).toBe(true);
      expect(client.upsert).toHaveBeenCalledOnce();
      const chunks = client.upsert.mock.calls[0][0] as MemoryChunk[];
      expect(chunks[0].metadata.role).toBe("user");
      expect(chunks[0].metadata.sourceType).toBe("session_turn");
    });

    it("ingests assistant messages", async () => {
      const client = createMockClient();
      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
      });

      const result = await engine.ingest({
        sessionId: "s1",
        message: { role: "assistant", content: "I can help with that." },
      });

      expect(result.ingested).toBe(true);
      expect(client.upsert).toHaveBeenCalledOnce();
    });

    it("skips roles not in ingestRoles", async () => {
      const client = createMockClient();
      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
        ingestRoles: ["user"],
      });

      const result = await engine.ingest({
        sessionId: "s1",
        message: { role: "assistant", content: "skipped" },
      });

      expect(result.ingested).toBe(false);
      expect(client.upsert).not.toHaveBeenCalled();
    });

    it("skips empty content", async () => {
      const client = createMockClient();
      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
      });

      const result = await engine.ingest({
        sessionId: "s1",
        message: { role: "user", content: "" },
      });

      expect(result.ingested).toBe(false);
      expect(client.upsert).not.toHaveBeenCalled();
    });

    it("does not throw on upsert failure — logs and returns ingested: false", async () => {
      const client = createMockClient();
      client.upsert.mockRejectedValue(new Error("Pinecone down"));

      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
      });

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await engine.ingest({
        sessionId: "s1",
        message: { role: "user", content: "will fail" },
      });

      expect(result.ingested).toBe(false);
      expect(consoleSpy).toHaveBeenCalled();
    });

    it("produces identical chunk IDs for the same message (idempotent turnId)", async () => {
      const client = createMockClient();
      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
      });

      const message = { role: "user" as const, content: "Hello, world!" };

      await engine.ingest({ sessionId: "s1", message });
      await engine.ingest({ sessionId: "s1", message });

      expect(client.upsert).toHaveBeenCalledTimes(2);
      const chunks1 = client.upsert.mock.calls[0][0] as MemoryChunk[];
      const chunks2 = client.upsert.mock.calls[1][0] as MemoryChunk[];
      expect(chunks1[0].id).toBe(chunks2[0].id);
      expect(chunks1[0].metadata.turnId).toBe(chunks2[0].metadata.turnId);
    });

    it("produces different chunk IDs for different messages in the same session", async () => {
      const client = createMockClient();
      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
      });

      await engine.ingest({
        sessionId: "s1",
        message: { role: "user", content: "Hello" },
      });
      await engine.ingest({
        sessionId: "s1",
        message: { role: "assistant", content: "World" },
      });

      expect(client.upsert).toHaveBeenCalledTimes(2);
      const chunks1 = client.upsert.mock.calls[0][0] as MemoryChunk[];
      const chunks2 = client.upsert.mock.calls[1][0] as MemoryChunk[];
      expect(chunks1[0].id).not.toBe(chunks2[0].id);
    });

    it("retries on 429 up to 3 times (4 total attempts) before giving up gracefully", async () => {
      const client = createMockClient();
      const rateLimitError = Object.assign(new Error("429"), { status: 429 });
      client.upsert
        .mockRejectedValueOnce(rateLimitError)
        .mockRejectedValueOnce(rateLimitError)
        .mockRejectedValueOnce(rateLimitError)
        .mockRejectedValueOnce(rateLimitError);

      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
      });

      vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await engine.ingest({
        sessionId: "s1",
        message: { role: "user", content: "rate limited" },
      });

      expect(result.ingested).toBe(false);
      // initial + 3 retries = 4 total attempts
      expect(client.upsert).toHaveBeenCalledTimes(4);
    });
  });

  describe("assemble", () => {
    it("queries Pinecone with recent turns and returns systemPromptAddition", async () => {
      const client = createMockClient();
      const queryResults: QueryResult[] = [
        {
          chunk: {
            id: "a:b:0",
            text: "Previous conversation about testing",
            metadata: {
              agentId: "test-agent",
              sourceFile: "session:s0",
              sourceType: "session_turn",
              chunkIndex: 0,
              createdAt: Date.now(),
            },
          },
          score: 0.85,
        },
      ];
      client.query.mockResolvedValue(queryResults);

      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
      });

      const messages = [{ role: "user" as const, content: "How do I write tests?" }];

      const result = await engine.assemble({
        sessionId: "s1",
        messages,
      });

      expect(client.query).toHaveBeenCalledOnce();
      const queryParams = client.query.mock.calls[0][0] as QueryParams;
      expect(queryParams.topK).toBe(20);
      expect(queryParams.minScore).toBe(0.7);
      expect(queryParams.agentId).toBe("test-agent");
      expect(result.systemPromptAddition).toContain("Relevant Memory");
      expect(result.systemPromptAddition).toContain("Previous conversation about testing");
      expect(result.messages).toBe(messages);
    });

    it("uses last 3 turns for query construction", async () => {
      const client = createMockClient();
      client.query.mockResolvedValue([]);

      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
      });

      const messages = [
        { role: "user" as const, content: "Turn 1" },
        { role: "assistant" as const, content: "Reply 1" },
        { role: "user" as const, content: "Turn 2" },
        { role: "assistant" as const, content: "Reply 2" },
        { role: "user" as const, content: "Turn 3" },
      ];

      await engine.assemble({ sessionId: "s1", messages });

      const queryParams = client.query.mock.calls[0][0] as QueryParams;
      expect(queryParams.text).toContain("Turn 2");
      expect(queryParams.text).toContain("Reply 2");
      expect(queryParams.text).toContain("Turn 3");
      expect(queryParams.text).not.toContain("Turn 1");
      expect(queryParams.text).not.toContain("Reply 1");
    });

    it("returns empty systemPromptAddition when no results", async () => {
      const client = createMockClient();
      client.query.mockResolvedValue([]);

      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
      });

      const result = await engine.assemble({
        sessionId: "s1",
        messages: [{ role: "user" as const, content: "anything" }],
      });

      expect(result.systemPromptAddition).toBeUndefined();
      expect(result.estimatedTokens).toBe(0);
    });

    it("returns empty when messages are empty", async () => {
      const client = createMockClient();
      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
      });

      const result = await engine.assemble({
        sessionId: "s1",
        messages: [],
      });

      expect(client.query).not.toHaveBeenCalled();
      expect(result.estimatedTokens).toBe(0);
    });

    it("respects tokenBudget — truncates results that exceed budget", async () => {
      const client = createMockClient();
      const longText = "A".repeat(40000); // ~10000 ASCII tokens
      const shortText = "Short memory";

      client.query.mockResolvedValue([
        {
          chunk: {
            id: "a:b:0",
            text: shortText,
            metadata: {
              agentId: "a",
              sourceFile: "s",
              sourceType: "session_turn" as const,
              chunkIndex: 0,
              createdAt: Date.now(),
            },
          },
          score: 0.95,
        },
        {
          chunk: {
            id: "a:b:1",
            text: longText,
            metadata: {
              agentId: "a",
              sourceFile: "s",
              sourceType: "session_turn" as const,
              chunkIndex: 1,
              createdAt: Date.now(),
            },
          },
          score: 0.8,
        },
      ]);

      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
        tokenBudget: 100,
      });

      const result = await engine.assemble({
        sessionId: "s1",
        messages: [{ role: "user" as const, content: "query" }],
      });

      expect(result.systemPromptAddition).toContain(shortText);
      expect(result.systemPromptAddition).not.toContain(longText);
    });

    it("falls back to fallbackAdapter on Pinecone failure", async () => {
      const client = createMockClient();
      client.query.mockRejectedValue(new Error("connection refused"));

      const fallback = createMockFallback();
      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
        fallbackAdapter: fallback,
      });

      vi.spyOn(console, "error").mockImplementation(() => {});

      const messages = [{ role: "user" as const, content: "test" }];
      const result = await engine.assemble({ sessionId: "s1", messages });

      expect(fallback.assemble).toHaveBeenCalled();
      expect(result.systemPromptAddition).toBe("fallback content");
    });

    it("falls back after 3-second timeout", async () => {
      vi.useFakeTimers();

      const client = createMockClient();
      // query never resolves (simulates hang)
      client.query.mockImplementation(() => new Promise(() => {}));

      const fallback = createMockFallback();
      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
        fallbackAdapter: fallback,
      });

      vi.spyOn(console, "error").mockImplementation(() => {});

      const messages = [{ role: "user" as const, content: "test" }];
      const promise = engine.assemble({ sessionId: "s1", messages });
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(fallback.assemble).toHaveBeenCalled();
      expect(result.systemPromptAddition).toBe("fallback content");

      vi.useRealTimers();
    });

    it("appends memoryHint to thin query when calling Pinecone", async () => {
      const client = createMockClient();
      client.query.mockResolvedValue([]);

      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "mell",
        memoryHint: "eSTACK AI agent service",
      });

      const messages = [
        { role: "user" as const, content: "あの件どうなった？" },
      ];

      await engine.assemble({ sessionId: "s1", messages });

      const queryParams = client.query.mock.calls[0][0] as QueryParams;
      expect(queryParams.text).toContain("あの件どうなった？");
      expect(queryParams.text).toContain("eSTACK AI agent service");
    });

    it("does not append memoryHint to rich query", async () => {
      const client = createMockClient();
      client.query.mockResolvedValue([]);

      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "mell",
        memoryHint: "eSTACK AI agent service",
      });

      const messages = [
        { role: "user" as const, content: "セントラルHDの長田さんとの3月11日アポの結果を教えて" },
      ];

      await engine.assemble({ sessionId: "s1", messages });

      const queryParams = client.query.mock.calls[0][0] as QueryParams;
      expect(queryParams.text).not.toContain("eSTACK AI agent service");
    });

    it("returns empty systemPromptAddition on failure without fallbackAdapter", async () => {
      const client = createMockClient();
      client.query.mockRejectedValue(new Error("connection refused"));

      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
        // no fallbackAdapter
      });

      vi.spyOn(console, "error").mockImplementation(() => {});

      const messages = [{ role: "user" as const, content: "test" }];
      const result = await engine.assemble({ sessionId: "s1", messages });

      // EmptyFallbackContextEngine returns no systemPromptAddition
      expect(result.systemPromptAddition).toBeUndefined();
      expect(result.estimatedTokens).toBe(0);
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

    it("upserts old turns and returns compacted: true", async () => {
      const client = createMockClient();
      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
        compactAfterDays: 7,
      });

      const sessionFile = path.join(tmpDir, "session.jsonl");
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      writeSessionFile(sessionFile, [
        {
          timestamp: eightDaysAgo,
          message: { role: "user", content: "old message" },
        },
        {
          timestamp: Date.now(),
          message: { role: "user", content: "recent message" },
        },
      ]);

      const result = await engine.compact({
        sessionId: "s1",
        sessionFile,
      });

      expect(result.ok).toBe(true);
      expect(result.compacted).toBe(true);
      expect(client.upsert).toHaveBeenCalledOnce();
      // Only the old message should be upserted
      const chunks = client.upsert.mock.calls[0][0] as MemoryChunk[];
      expect(chunks[0].text).toBe("old message");
    });

    it("returns compacted: false when no old turns exist", async () => {
      const client = createMockClient();
      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
      });

      const sessionFile = path.join(tmpDir, "session.jsonl");
      writeSessionFile(sessionFile, [
        {
          timestamp: Date.now(),
          message: { role: "user", content: "recent" },
        },
      ]);

      const result = await engine.compact({
        sessionId: "s1",
        sessionFile,
      });

      expect(result.ok).toBe(true);
      expect(result.compacted).toBe(false);
      expect(client.upsert).not.toHaveBeenCalled();
    });

    it("aborts on upsert failure — does not return compacted: true", async () => {
      const client = createMockClient();
      client.upsert.mockRejectedValue(new Error("upsert failed"));

      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
        compactAfterDays: 7,
      });

      const sessionFile = path.join(tmpDir, "session.jsonl");
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      writeSessionFile(sessionFile, [
        {
          timestamp: eightDaysAgo,
          message: { role: "user", content: "old message" },
        },
      ]);

      vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await engine.compact({
        sessionId: "s1",
        sessionFile,
      });

      expect(result.ok).toBe(false);
      expect(result.compacted).toBe(false);
    });

    it("handles missing session file gracefully", async () => {
      const client = createMockClient();
      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
      });

      const result = await engine.compact({
        sessionId: "s1",
        sessionFile: "/nonexistent/file.jsonl",
      });

      expect(result.ok).toBe(true);
      expect(result.compacted).toBe(false);
    });

    it("skips entries where message.role is not a string", async () => {
      const client = createMockClient();
      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
        compactAfterDays: 7,
      });

      const sessionFile = path.join(tmpDir, "session.jsonl");
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      const entries = [
        { timestamp: eightDaysAgo, message: { role: 123, content: "bad role" } },
        { timestamp: eightDaysAgo, message: { role: "user", content: "valid" } },
      ];
      fs.writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join("\n"), "utf-8");

      const result = await engine.compact({ sessionId: "s1", sessionFile });

      expect(result.compacted).toBe(true);
      expect(client.upsert).toHaveBeenCalledOnce();
      const chunks = client.upsert.mock.calls[0][0] as MemoryChunk[];
      expect(chunks.every((c) => c.text !== "bad role")).toBe(true);
    });

    it("skips entries where message.content is undefined", async () => {
      const client = createMockClient();
      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
        compactAfterDays: 7,
      });

      const sessionFile = path.join(tmpDir, "session.jsonl");
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      const entries = [
        { timestamp: eightDaysAgo, message: { role: "user" } },
        { timestamp: eightDaysAgo, message: { role: "user", content: "valid" } },
      ];
      fs.writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join("\n"), "utf-8");

      const result = await engine.compact({ sessionId: "s1", sessionFile });

      expect(result.compacted).toBe(true);
      expect(client.upsert).toHaveBeenCalledOnce();
      const chunks = client.upsert.mock.calls[0][0] as MemoryChunk[];
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.every((c) => c.text === "valid")).toBe(true);
    });

    it("skips old turns matching skipPatterns", async () => {
      const client = createMockClient();
      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
        compactAfterDays: 7,
        skipPatterns: ["記憶しないで"],
      });

      const sessionFile = path.join(tmpDir, "session.jsonl");
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      writeSessionFile(sessionFile, [
        {
          timestamp: eightDaysAgo,
          message: { role: "user", content: "記憶しないでください" },
        },
        {
          timestamp: eightDaysAgo,
          message: { role: "user", content: "normal message" },
        },
      ]);

      const result = await engine.compact({ sessionId: "s1", sessionFile });

      expect(result.compacted).toBe(true);
      expect(client.upsert).toHaveBeenCalledOnce();
      const chunks = client.upsert.mock.calls[0][0] as MemoryChunk[];
      expect(chunks.every((c) => !c.text.includes("記憶しないで"))).toBe(true);
      expect(chunks.some((c) => c.text === "normal message")).toBe(true);
    });

    it("applies defaultCategory to chunk metadata", async () => {
      const client = createMockClient();
      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
        compactAfterDays: 7,
        defaultCategory: "archive",
      });

      const sessionFile = path.join(tmpDir, "session.jsonl");
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      writeSessionFile(sessionFile, [
        {
          timestamp: eightDaysAgo,
          message: { role: "user", content: "old message" },
        },
      ]);

      const result = await engine.compact({ sessionId: "s1", sessionFile });

      expect(result.compacted).toBe(true);
      const chunks = client.upsert.mock.calls[0][0] as MemoryChunk[];
      expect(chunks[0].metadata.category).toBe("archive");
    });

    it("uses custom compactAfterDays", async () => {
      const client = createMockClient();
      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
        compactAfterDays: 1, // 1 day
      });

      const sessionFile = path.join(tmpDir, "session.jsonl");
      const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
      writeSessionFile(sessionFile, [
        {
          timestamp: twoDaysAgo,
          message: { role: "user", content: "2 days old" },
        },
      ]);

      const result = await engine.compact({
        sessionId: "s1",
        sessionFile,
      });

      expect(result.compacted).toBe(true);
      expect(client.upsert).toHaveBeenCalled();
    });
  });

  describe("ingest - category", () => {
    it("sets default category 'conversation' on ingested chunks", async () => {
      const client = createMockClient();
      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
      });

      await engine.ingest({
        sessionId: "s1",
        message: { role: "user", content: "Hello" },
      });

      const chunks = client.upsert.mock.calls[0][0] as MemoryChunk[];
      expect(chunks[0].metadata.category).toBe("conversation");
    });

    it("uses custom defaultCategory when specified", async () => {
      const client = createMockClient();
      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
        defaultCategory: "memory",
      });

      await engine.ingest({
        sessionId: "s1",
        message: { role: "user", content: "Hello" },
      });

      const chunks = client.upsert.mock.calls[0][0] as MemoryChunk[];
      expect(chunks[0].metadata.category).toBe("memory");
    });
  });

  describe("ingest - skip patterns", () => {
    it("skips messages containing default skip pattern", async () => {
      const engine = new PineconeContextEngine({
        pineconeClient: createMockClient(),
        agentId: "test",
      });

      const result = await engine.ingest({
        sessionId: "s1",
        message: { role: "user", content: "これは記憶しないでください" },
      });

      expect(result.ingested).toBe(false);
    });

    it("ingests messages that do not match any skip pattern", async () => {
      const mockClient = createMockClient();
      const engine = new PineconeContextEngine({
        pineconeClient: mockClient,
        agentId: "test",
      });

      const result = await engine.ingest({
        sessionId: "s1",
        message: { role: "user", content: "今日はいい天気ですね" },
      });

      expect(result.ingested).toBe(true);
      expect(mockClient.upsert).toHaveBeenCalled();
    });

    it("supports custom skipPatterns override", async () => {
      const engine = new PineconeContextEngine({
        pineconeClient: createMockClient(),
        agentId: "test",
        skipPatterns: ["custom-skip-keyword"],
      });

      const result = await engine.ingest({
        sessionId: "s1",
        message: { role: "user", content: "custom-skip-keyword in message" },
      });

      expect(result.ingested).toBe(false);
    });

    it("is case-insensitive for skip patterns", async () => {
      const engine = new PineconeContextEngine({
        pineconeClient: createMockClient(),
        agentId: "test",
        skipPatterns: ["NO MEMORY"],
      });

      const result = await engine.ingest({
        sessionId: "s1",
        message: { role: "user", content: "no memory please" },
      });

      expect(result.ingested).toBe(false);
    });
  });

  describe("dispose", () => {
    it("completes without error", async () => {
      const engine = new PineconeContextEngine({
        pineconeClient: createMockClient(),
        agentId: "test-agent",
      });

      await expect(engine.dispose()).resolves.toBeUndefined();
    });
  });
});

describe("buildEnrichedQuery", () => {
  it("薄いクエリ（20トークン未満）には memoryHint を付加する", () => {
    const result = buildEnrichedQuery("あの件どうなった？", "eSTACK AI agent");
    expect(result).toContain("eSTACK AI agent");
  });

  it("十分なクエリ（固有名詞あり・20トークン以上）はそのまま返す", () => {
    const result = buildEnrichedQuery(
      "セントラルHDの長田さんとの3月11日アポの結果を教えて",
      "eSTACK AI agent",
    );
    expect(result).not.toContain("eSTACK AI agent");
  });

  it("memoryHint なしでも動作する", () => {
    const result = buildEnrichedQuery("あの件は？");
    expect(result).toBe("あの件は？");
  });
});

describe("isQueryThin", () => {
  it("短いクエリは thin と判定", () => {
    expect(isQueryThin("hello")).toBe(true);
  });

  it("十分な長さで固有名詞ありのクエリは thin でない", () => {
    expect(isQueryThin("セントラルHDの長田さんとの3月11日アポの結果を教えて")).toBe(false);
  });

  it("ASCII のみで固有名詞なしのクエリは thin", () => {
    expect(isQueryThin("what about that thing we discussed?")).toBe(true);
  });

  it("ひらがなのみの長文は固有名詞なしとして thin と判定", () => {
    expect(isQueryThin("おはようございます。きょうもよろしくおねがいします。ほんじつのよていについてかくにんさせてください。")).toBe(true);
  });
});

describe("estimateTokens", () => {
  it("estimates ASCII text correctly", () => {
    // "hello" = 5 chars × 0.25 = 1.25 → ceil = 2
    expect(estimateTokens("hello")).toBe(2);
    // 40 ASCII chars × 0.25 = 10 tokens
    expect(estimateTokens("a".repeat(40))).toBe(10);
    // 100 ASCII chars × 0.25 = 25 tokens
    expect(estimateTokens("a".repeat(100))).toBe(25);
  });

  it("estimates Japanese hiragana correctly (1.5x factor)", () => {
    // "あいうえお" = 5 chars × 1.5 = 7.5 → ceil = 8
    expect(estimateTokens("あいうえお")).toBe(8);
    // 100 Japanese chars × 1.5 = 150 tokens
    expect(estimateTokens("あ".repeat(100))).toBe(150);
  });

  it("estimates Japanese kanji correctly (1.5x factor)", () => {
    // "東京都" = 3 chars × 1.5 = 4.5 → ceil = 5
    expect(estimateTokens("東京都")).toBe(5);
  });

  it("estimates mixed Japanese+ASCII text correctly", () => {
    // "Hello世界" = 5 ASCII (1.25) + 2 CJK (3.0) = 4.25 → ceil = 5
    expect(estimateTokens("Hello世界")).toBe(5);
    // 10 Japanese (15) + 10 ASCII (2.5) = 17.5 → ceil = 18
    expect(estimateTokens("あ".repeat(10) + "a".repeat(10))).toBe(18);
  });

  it("estimates Japanese sentence with exact value", () => {
    // "今日は良い天気ですね。明日も晴れると良いな。" = 22 chars
    // All CJK/punctuation (U+3000–U+9FFF) × 1.5 = 33 → ceil = 33
    const japaneseText = "今日は良い天気ですね。明日も晴れると良いな。";
    expect(estimateTokens(japaneseText)).toBe(33);
  });

  it("estimates fullwidth ASCII correctly (1.0x factor)", () => {
    // "ａｂｃ" = 3 fullwidth chars (U+FF00–U+FFEF) × 1.0 = 3
    expect(estimateTokens("ａｂｃ")).toBe(3);
  });

  it("estimates halfwidth katakana correctly (1.0x factor)", () => {
    // "ｦｧｨ" = 3 halfwidth katakana (U+FF00–U+FFEF) × 1.0 = 3
    expect(estimateTokens("ｦｧｨ")).toBe(3);
  });

  it("estimates emoji/other non-ASCII correctly (1.0x factor)", () => {
    // "é" (U+00E9) = 1 char × 1.0 = 1
    expect(estimateTokens("é")).toBe(1);
    // "ñ" (U+00F1) = 1 char × 1.0 = 1
    expect(estimateTokens("ñ")).toBe(1);
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });
});
