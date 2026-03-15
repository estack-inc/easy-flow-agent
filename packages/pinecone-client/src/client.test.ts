import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryChunk } from "./types.js";

// Mock @pinecone-database/pinecone before importing client
vi.mock("@pinecone-database/pinecone", () => {
  const mockNamespace = {
    upsert: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ matches: [] }),
    deleteMany: vi.fn().mockResolvedValue(undefined),
    deleteAll: vi.fn().mockResolvedValue(undefined),
    listPaginated: vi.fn().mockResolvedValue({ vectors: [] }),
  };

  const mockIndex = {
    namespace: vi.fn().mockReturnValue(mockNamespace),
  };

  const MockPinecone = vi.fn().mockImplementation(() => ({
    index: vi.fn().mockReturnValue(mockIndex),
    listIndexes: vi.fn().mockResolvedValue({ indexes: [{ name: "easy-flow-memory" }] }),
    createIndex: vi.fn().mockResolvedValue(undefined),
    inference: {
      embed: vi
        .fn()
        .mockImplementation((params: { inputs: string[] }) =>
          Promise.resolve({ data: params.inputs.map(() => ({ values: Array(1024).fill(0.1) })) }),
        ),
    },
  }));

  return { Pinecone: MockPinecone };
});

import { Pinecone } from "@pinecone-database/pinecone";
import { PineconeClient } from "./client.js";

function createChunk(overrides: Partial<MemoryChunk> = {}): MemoryChunk {
  return {
    id: "mell:MEMORY.md:0",
    text: "Test memory content",
    metadata: {
      agentId: "mell",
      sourceFile: "MEMORY.md",
      sourceType: "memory_file",
      chunkIndex: 0,
      createdAt: Date.now(),
    },
    ...overrides,
  };
}

describe("PineconeClient", () => {
  let client: PineconeClient;
  let mockPineconeInstance: any;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new PineconeClient({ apiKey: "test-api-key" });
    // Get the mock instance created by the constructor
    mockPineconeInstance = (Pinecone as any).mock.results[(Pinecone as any).mock.results.length - 1]
      .value;
  });

  describe("ensureIndex", () => {
    it("does not create index if it already exists", async () => {
      await client.ensureIndex();
      expect(mockPineconeInstance.createIndex).not.toHaveBeenCalled();
    });

    it("creates index if it does not exist", async () => {
      mockPineconeInstance.listIndexes.mockResolvedValueOnce({ indexes: [] });
      // Need a new client to pick up the mock
      const newClient = new PineconeClient({ apiKey: "test-key" });
      const newInstance = (Pinecone as any).mock.results[(Pinecone as any).mock.results.length - 1]
        .value;
      newInstance.listIndexes.mockResolvedValueOnce({ indexes: [] });

      await newClient.ensureIndex();
      expect(newInstance.createIndex).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "easy-flow-memory",
          dimension: 1024,
          metric: "cosine",
        }),
      );
    });
  });

  describe("upsert", () => {
    it("does nothing for empty chunks array", async () => {
      await client.upsert([]);
      expect(mockPineconeInstance.inference.embed).not.toHaveBeenCalled();
    });

    it("generates embeddings and upserts to correct namespace", async () => {
      const chunks = [createChunk()];
      await client.upsert(chunks);

      expect(mockPineconeInstance.inference.embed).toHaveBeenCalledWith({
        model: "multilingual-e5-large",
        inputs: ["Test memory content"],
        parameters: { input_type: "passage", truncate: "END" },
      });

      const mockIndex = mockPineconeInstance.index();
      expect(mockIndex.namespace).toHaveBeenCalledWith("agent:mell");

      const mockNs = mockIndex.namespace();
      expect(mockNs.upsert).toHaveBeenCalledWith({
        records: expect.arrayContaining([
          expect.objectContaining({
            id: "mell:MEMORY.md:0",
            values: expect.any(Array),
            metadata: expect.objectContaining({
              agentId: "mell",
              sourceFile: "MEMORY.md",
              text: "Test memory content",
            }),
          }),
        ]),
      });
    });

    it("throws if chunks have mixed agentIds", async () => {
      const chunks = [
        createChunk({ metadata: { ...createChunk().metadata, agentId: "mell" } }),
        createChunk({ metadata: { ...createChunk().metadata, agentId: "other" } }),
      ];
      await expect(client.upsert(chunks)).rejects.toThrow("All chunks must have the same agentId");
    });

    it("upserts multiple chunks", async () => {
      const chunks = [
        createChunk({ id: "mell:MEMORY.md:0", text: "chunk 0" }),
        createChunk({
          id: "mell:MEMORY.md:1",
          text: "chunk 1",
          metadata: { ...createChunk().metadata, chunkIndex: 1 },
        }),
      ];

      await client.upsert(chunks);

      const mockNs = mockPineconeInstance.index().namespace();
      const upsertCall = mockNs.upsert.mock.calls[0][0];
      expect(upsertCall.records).toHaveLength(2);
    });

    it("splits into multiple batches when chunks exceed 100", async () => {
      const chunks = Array.from({ length: 150 }, (_, i) =>
        createChunk({
          id: `mell:MEMORY.md:${i}`,
          text: `chunk ${i}`,
          metadata: { ...createChunk().metadata, chunkIndex: i },
        }),
      );

      await client.upsert(chunks);

      const mockNs = mockPineconeInstance.index().namespace();
      expect(mockNs.upsert).toHaveBeenCalledTimes(2);
      expect(mockNs.upsert.mock.calls[0][0].records).toHaveLength(100);
      expect(mockNs.upsert.mock.calls[1][0].records).toHaveLength(50);
    });
  });

  describe("query", () => {
    it("queries with correct parameters and filters by minScore", async () => {
      const mockNs = mockPineconeInstance.index().namespace();
      mockNs.query.mockResolvedValueOnce({
        matches: [
          {
            id: "mell:MEMORY.md:0",
            score: 0.95,
            metadata: {
              agentId: "mell",
              sourceFile: "MEMORY.md",
              sourceType: "memory_file",
              chunkIndex: 0,
              createdAt: 1000,
              text: "relevant memory",
            },
          },
          {
            id: "mell:MEMORY.md:1",
            score: 0.5, // below minScore
            metadata: {
              agentId: "mell",
              sourceFile: "MEMORY.md",
              sourceType: "memory_file",
              chunkIndex: 1,
              createdAt: 1000,
              text: "irrelevant memory",
            },
          },
        ],
      });

      const results = await client.query({
        text: "search query",
        agentId: "mell",
      });

      expect(mockPineconeInstance.inference.embed).toHaveBeenCalledWith({
        model: "multilingual-e5-large",
        inputs: ["search query"],
        parameters: { input_type: "query", truncate: "END" },
      });

      expect(results).toHaveLength(1);
      expect(results[0].score).toBe(0.95);
      expect(results[0].chunk.text).toBe("relevant memory");
      expect(results[0].chunk.id).toBe("mell:MEMORY.md:0");
    });

    it("uses default topK=20 and minScore=0.7", async () => {
      const mockNs = mockPineconeInstance.index().namespace();
      mockNs.query.mockResolvedValueOnce({ matches: [] });

      await client.query({ text: "test", agentId: "mell" });

      expect(mockNs.query).toHaveBeenCalledWith(
        expect.objectContaining({
          topK: 20,
          includeMetadata: true,
        }),
      );
    });

    it("passes custom topK and filter", async () => {
      const mockNs = mockPineconeInstance.index().namespace();
      mockNs.query.mockResolvedValueOnce({ matches: [] });

      await client.query({
        text: "test",
        agentId: "mell",
        topK: 5,
        filter: { sourceType: "session_turn" },
      });

      expect(mockNs.query).toHaveBeenCalledWith(
        expect.objectContaining({
          topK: 5,
          filter: { sourceType: "session_turn" },
        }),
      );
    });

    it("returns empty array when no matches", async () => {
      const mockNs = mockPineconeInstance.index().namespace();
      mockNs.query.mockResolvedValueOnce({ matches: [] });

      const results = await client.query({ text: "test", agentId: "mell" });
      expect(results).toEqual([]);
    });
  });

  describe("delete", () => {
    it("does nothing for empty ids array", async () => {
      await client.delete([]);
      const mockNs = mockPineconeInstance.index().namespace();
      expect(mockNs.deleteMany).not.toHaveBeenCalled();
    });

    it("throws if ids have mixed agentIds", async () => {
      await expect(client.delete(["mell:a.md:0", "other:b.md:0"])).rejects.toThrow(
        "All ids must belong to the same agentId",
      );
    });

    it("deletes by ids in correct namespace", async () => {
      await client.delete(["mell:MEMORY.md:0", "mell:MEMORY.md:1"]);

      const mockIndex = mockPineconeInstance.index();
      expect(mockIndex.namespace).toHaveBeenCalledWith("agent:mell");

      const mockNs = mockIndex.namespace();
      expect(mockNs.deleteMany).toHaveBeenCalledWith({
        ids: ["mell:MEMORY.md:0", "mell:MEMORY.md:1"],
      });
    });
  });

  describe("deleteBySource", () => {
    it("lists and deletes vectors by prefix", async () => {
      const mockNs = mockPineconeInstance.index().namespace();
      mockNs.listPaginated.mockResolvedValueOnce({
        vectors: [{ id: "mell:MEMORY.md:0" }, { id: "mell:MEMORY.md:1" }],
      });

      await client.deleteBySource("mell", "MEMORY.md");

      expect(mockNs.listPaginated).toHaveBeenCalledWith({
        prefix: "mell:MEMORY.md:",
      });
      expect(mockNs.deleteMany).toHaveBeenCalledWith({
        ids: ["mell:MEMORY.md:0", "mell:MEMORY.md:1"],
      });
    });

    it("handles pagination", async () => {
      const mockNs = mockPineconeInstance.index().namespace();
      mockNs.listPaginated
        .mockResolvedValueOnce({
          vectors: [{ id: "mell:file.md:0" }],
          pagination: { next: "token1" },
        })
        .mockResolvedValueOnce({
          vectors: [{ id: "mell:file.md:1" }],
        });

      await client.deleteBySource("mell", "file.md");

      expect(mockNs.listPaginated).toHaveBeenCalledTimes(2);
      expect(mockNs.deleteMany).toHaveBeenCalledWith({
        ids: ["mell:file.md:0", "mell:file.md:1"],
      });
    });

    it("does not call deleteMany when no vectors found", async () => {
      const mockNs = mockPineconeInstance.index().namespace();
      mockNs.listPaginated.mockResolvedValueOnce({ vectors: [] });

      await client.deleteBySource("mell", "nonexistent.md");
      expect(mockNs.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe("deleteNamespace", () => {
    it("calls deleteAll on the correct namespace", async () => {
      await client.deleteNamespace("mell");

      const mockIndex = mockPineconeInstance.index();
      expect(mockIndex.namespace).toHaveBeenCalledWith("agent:mell");

      const mockNs = mockIndex.namespace();
      expect(mockNs.deleteAll).toHaveBeenCalled();
    });
  });

  describe("constructor", () => {
    it("uses default index name", () => {
      new PineconeClient({ apiKey: "key" });
      expect(Pinecone).toHaveBeenCalledWith({ apiKey: "key" });
    });

    it("accepts custom index name", () => {
      new PineconeClient({ apiKey: "key", indexName: "custom-index" });
      expect(Pinecone).toHaveBeenCalled();
    });
  });
});
