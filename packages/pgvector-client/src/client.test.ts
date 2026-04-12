import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgVectorClient } from "./client.js";

// Mock pg
const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
const mockRelease = vi.fn();
const mockConnect = vi.fn().mockResolvedValue({
  query: mockQuery,
  release: mockRelease,
});
const mockEnd = vi.fn().mockResolvedValue(undefined);

vi.mock("pg", () => ({
  Pool: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    end: mockEnd,
  })),
}));

// Mock pgvector
vi.mock("pgvector/pg", () => ({
  default: {
    registerTypes: vi.fn().mockResolvedValue(undefined),
    toSql: vi.fn((v: number[]) => `[${v.join(",")}]`),
  },
}));

// Mock embedding service
const mockEmbed = vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]);
vi.mock("./embedding.js", () => ({
  GeminiEmbeddingService: vi.fn().mockImplementation(() => ({
    embed: mockEmbed,
  })),
}));

// Mock schema
vi.mock("./schema.js", () => ({
  ensureSchema: vi.fn().mockResolvedValue(undefined),
}));

function makeChunk(agentId: string, sourceFile: string, chunkIndex: number, text: string) {
  return {
    id: `${agentId}:${sourceFile}:${chunkIndex}`,
    text,
    metadata: {
      agentId,
      sourceFile,
      sourceType: "session_turn" as const,
      chunkIndex,
      createdAt: Date.now(),
    },
  };
}

describe("PgVectorClient", () => {
  let client: PgVectorClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [] });
    mockEmbed.mockResolvedValue([[0.1, 0.2, 0.3]]);
    client = new PgVectorClient({
      databaseUrl: "postgres://test:test@localhost:5432/test",
      geminiApiKey: "test-key",
    });
  });

  describe("ensureIndex", () => {
    it("should call ensureSchema", async () => {
      const { ensureSchema } = await import("./schema.js");
      await client.ensureIndex();
      expect(ensureSchema).toHaveBeenCalled();
    });
  });

  describe("upsert", () => {
    it("should embed texts and insert with ON CONFLICT upsert", async () => {
      mockEmbed.mockResolvedValueOnce([[0.1, 0.2, 0.3]]);
      const chunks = [makeChunk("mell", "session:abc:hash", 0, "hello world")];

      await client.upsert(chunks);

      expect(mockEmbed).toHaveBeenCalledWith(["hello world"], "RETRIEVAL_DOCUMENT");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO memory_vectors"),
        expect.arrayContaining(["mell:session:abc:hash:0", "agent:mell"]),
      );
    });

    it("should reject mixed agentId chunks", async () => {
      const chunks = [makeChunk("mell", "file1", 0, "a"), makeChunk("tom", "file1", 0, "b")];
      await expect(client.upsert(chunks)).rejects.toThrow("same agentId");
    });

    it("should skip empty chunks", async () => {
      await client.upsert([]);
      expect(mockEmbed).not.toHaveBeenCalled();
    });
  });

  describe("query", () => {
    it("should embed query text and search by cosine distance", async () => {
      mockEmbed.mockResolvedValueOnce([[0.1, 0.2, 0.3]]);
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: "mell:session:abc:0",
            score: 0.9,
            text: "hello",
            metadata: {
              agentId: "mell",
              sourceFile: "session:abc",
              sourceType: "session_turn",
              chunkIndex: 0,
              createdAt: 1000,
              text: "hello",
            },
          },
        ],
      });

      const results = await client.query({
        text: "hello",
        agentId: "mell",
        topK: 10,
        minScore: 0.5,
      });

      expect(mockEmbed).toHaveBeenCalledWith(["hello"], "RETRIEVAL_QUERY");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("1 - (embedding <=>"),
        expect.arrayContaining(["agent:mell"]),
      );
      expect(results).toHaveLength(1);
      expect(results[0].score).toBe(0.9);
    });

    it("should filter by minScore", async () => {
      mockEmbed.mockResolvedValueOnce([[0.1, 0.2, 0.3]]);
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: "mell:a:0", score: 0.9, text: "high", metadata: { text: "high" } },
          { id: "mell:b:0", score: 0.3, text: "low", metadata: { text: "low" } },
        ],
      });

      const results = await client.query({
        text: "test",
        agentId: "mell",
        minScore: 0.5,
      });

      expect(results).toHaveLength(1);
      expect(results[0].chunk.text).toBe("high");
    });

    it("should apply category filter", async () => {
      mockEmbed.mockResolvedValueOnce([[0.1, 0.2, 0.3]]);
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await client.query({
        text: "test",
        agentId: "mell",
        filterCategory: "conversation",
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("metadata->>'category'"),
        expect.arrayContaining(["conversation"]),
      );
    });
  });

  describe("delete", () => {
    it("should delete by IDs within namespace", async () => {
      await client.delete(["mell:file:0", "mell:file:1"]);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM memory_vectors"),
        ["agent:mell", ["mell:file:0", "mell:file:1"]],
      );
    });

    it("should reject mixed agentId IDs", async () => {
      await expect(client.delete(["mell:f:0", "tom:f:0"])).rejects.toThrow("same agentId");
    });

    it("should skip empty IDs", async () => {
      await client.delete([]);
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe("deleteBySource", () => {
    it("should delete by ID prefix using LIKE", async () => {
      await client.deleteBySource("mell", "session:abc");

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM memory_vectors WHERE namespace = $1 AND id LIKE $2"),
        ["agent:mell", "mell:session:abc:%"],
      );
    });
  });

  describe("deleteNamespace", () => {
    it("should delete all vectors in namespace", async () => {
      await client.deleteNamespace("mell");

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM memory_vectors WHERE namespace = $1"),
        ["agent:mell"],
      );
    });
  });

  describe("dispose", () => {
    it("should end the pool", async () => {
      await client.dispose();
      expect(mockEnd).toHaveBeenCalled();
    });
  });
});
