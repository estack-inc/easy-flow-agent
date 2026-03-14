import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { PineconeContextEngine } from "./pinecone-context-engine.js";
import { estimateTokens } from "./token-estimator.js";
import type { IPineconeClient } from "./types.js";
import type {
  MemoryChunk,
  QueryResult,
  QueryParams,
} from "@easy-flow/pinecone-client";

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

    it("retries on 429 rate limit", async () => {
      const client = createMockClient();
      const rateLimitError = Object.assign(new Error("Rate limited"), {
        status: 429,
      });
      client.ensureIndex
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce(undefined);

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

    it("retries on 429 before giving up gracefully", async () => {
      const client = createMockClient();
      const rateLimitError = Object.assign(new Error("429"), { status: 429 });
      client.upsert
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
      expect(client.upsert).toHaveBeenCalledTimes(3);
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

      const messages = [
        { role: "user" as const, content: "How do I write tests?" },
      ];

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
      expect(result.systemPromptAddition).toContain(
        "Previous conversation about testing",
      );
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
          score: 0.80,
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

describe("estimateTokens", () => {
  it("estimates ASCII text tokens", () => {
    // 100 ASCII chars ≈ 25 tokens
    const text = "a".repeat(100);
    expect(estimateTokens(text)).toBe(25);
  });

  it("estimates Japanese text tokens", () => {
    // 100 Japanese chars ≈ 50 tokens
    const text = "あ".repeat(100);
    expect(estimateTokens(text)).toBe(50);
  });

  it("estimates mixed text tokens", () => {
    // 10 Japanese (5) + 10 ASCII (2.5) = 7.5 → ceil = 8
    const text = "あ".repeat(10) + "a".repeat(10);
    expect(estimateTokens(text)).toBe(8);
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });
});
