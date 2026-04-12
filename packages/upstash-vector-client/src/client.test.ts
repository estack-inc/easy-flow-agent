import { beforeEach, describe, expect, it, vi } from "vitest";
import { UpstashVectorClient } from "./client.js";

// Mock @upstash/vector
const mockInfo = vi.fn().mockResolvedValue({ vectorCount: 0 });
const mockUpsert = vi.fn().mockResolvedValue(undefined);
const mockQuery = vi.fn().mockResolvedValue([]);
const mockDelete = vi.fn().mockResolvedValue(undefined);
const mockReset = vi.fn().mockResolvedValue(undefined);
const mockRange = vi.fn().mockResolvedValue({ vectors: [], nextCursor: "" });

const mockNamespace = vi.fn().mockReturnValue({
  upsert: mockUpsert,
  query: mockQuery,
  delete: mockDelete,
  reset: mockReset,
  range: mockRange,
});

vi.mock("@upstash/vector", () => ({
  Index: vi.fn().mockImplementation(() => ({
    info: mockInfo,
    namespace: mockNamespace,
  })),
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

describe("UpstashVectorClient", () => {
  let client: UpstashVectorClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new UpstashVectorClient({ url: "https://test.upstash.io", token: "test-token" });
  });

  describe("ensureIndex", () => {
    it("should call index.info() to verify connectivity", async () => {
      await client.ensureIndex();
      expect(mockInfo).toHaveBeenCalled();
    });
  });

  describe("upsert", () => {
    it("should upsert chunks using data field for built-in embedding", async () => {
      const chunks = [makeChunk("mell", "session:abc:hash", 0, "hello world")];

      await client.upsert(chunks);

      expect(mockNamespace).toHaveBeenCalledWith("agent:mell");
      expect(mockUpsert).toHaveBeenCalledWith([
        {
          id: "mell:session:abc:hash:0",
          data: "hello world",
          metadata: {
            ...chunks[0].metadata,
            text: "hello world",
          },
        },
      ]);
    });

    it("should reject mixed agentId chunks", async () => {
      const chunks = [makeChunk("mell", "file1", 0, "a"), makeChunk("tom", "file1", 0, "b")];

      await expect(client.upsert(chunks)).rejects.toThrow("same agentId");
    });

    it("should skip empty chunks", async () => {
      await client.upsert([]);
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it("should batch upserts when exceeding batch size", async () => {
      const chunks = Array.from({ length: 150 }, (_, i) =>
        makeChunk("mell", `file:${i}`, i, `text ${i}`),
      );

      await client.upsert(chunks);

      expect(mockUpsert).toHaveBeenCalledTimes(2);
    });
  });

  describe("query", () => {
    it("should query using data field and filter by minScore", async () => {
      mockQuery.mockResolvedValueOnce([
        {
          id: "mell:session:abc:0",
          score: 0.9,
          metadata: {
            agentId: "mell",
            sourceFile: "session:abc",
            sourceType: "session_turn",
            chunkIndex: 0,
            createdAt: 1000,
            text: "hello",
          },
        },
        {
          id: "mell:session:def:0",
          score: 0.3,
          metadata: { text: "low score" },
        },
      ]);

      const results = await client.query({
        text: "hello",
        agentId: "mell",
        topK: 10,
        minScore: 0.5,
      });

      expect(mockNamespace).toHaveBeenCalledWith("agent:mell");
      expect(mockQuery).toHaveBeenCalledWith({
        data: "hello",
        topK: 10,
        includeMetadata: true,
        filter: undefined,
      });
      expect(results).toHaveLength(1);
      expect(results[0].score).toBe(0.9);
      expect(results[0].chunk.text).toBe("hello");
    });

    it("should apply category filter", async () => {
      mockQuery.mockResolvedValueOnce([]);

      await client.query({
        text: "test",
        agentId: "mell",
        filterCategory: "conversation",
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: "category = 'conversation'",
        }),
      );
    });

    it("should escape single quotes and backslashes in category filter", async () => {
      mockQuery.mockResolvedValueOnce([]);

      await client.query({
        text: "test",
        agentId: "mell",
        filterCategory: "it's a \\test\\",
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: "category = 'it\\'s a \\\\test\\\\'",
        }),
      );
    });
  });

  describe("delete", () => {
    it("should delete by IDs", async () => {
      await client.delete(["mell:file:0", "mell:file:1"]);

      expect(mockNamespace).toHaveBeenCalledWith("agent:mell");
      expect(mockDelete).toHaveBeenCalledWith(["mell:file:0", "mell:file:1"]);
    });

    it("should reject mixed agentId IDs", async () => {
      await expect(client.delete(["mell:f:0", "tom:f:0"])).rejects.toThrow("same agentId");
    });

    it("should skip empty IDs", async () => {
      await client.delete([]);
      expect(mockDelete).not.toHaveBeenCalled();
    });
  });

  describe("deleteBySource", () => {
    it("should scan range and delete matching IDs", async () => {
      mockRange.mockResolvedValueOnce({
        vectors: [
          { id: "mell:session:abc:0" },
          { id: "mell:session:abc:1" },
          { id: "mell:session:other:0" },
        ],
        nextCursor: "",
      });

      await client.deleteBySource("mell", "session:abc");

      expect(mockRange).toHaveBeenCalledWith({
        cursor: "0",
        limit: 100,
        includeMetadata: false,
      });
      expect(mockDelete).toHaveBeenCalledWith(["mell:session:abc:0", "mell:session:abc:1"]);
    });

    it("should paginate through range results", async () => {
      mockRange
        .mockResolvedValueOnce({
          vectors: [{ id: "mell:f:0" }],
          nextCursor: "cursor-1",
        })
        .mockResolvedValueOnce({
          vectors: [{ id: "mell:f:1" }],
          nextCursor: "",
        });

      await client.deleteBySource("mell", "f");

      expect(mockRange).toHaveBeenCalledTimes(2);
      expect(mockDelete).toHaveBeenCalledWith(["mell:f:0", "mell:f:1"]);
    });
  });

  describe("deleteNamespace", () => {
    it("should reset the namespace", async () => {
      await client.deleteNamespace("mell");

      expect(mockNamespace).toHaveBeenCalledWith("agent:mell");
      expect(mockReset).toHaveBeenCalled();
    });
  });
});
