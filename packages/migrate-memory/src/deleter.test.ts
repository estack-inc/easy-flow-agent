import { describe, it, expect, vi } from "vitest";
import { MemoryDeleter } from "./deleter.js";
import type { IPineconeClient } from "@easy-flow/pinecone-client";

function createMockClient(): IPineconeClient {
  return {
    upsert: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([
      { chunk: { id: "chunk-1", text: "田中花子の情報", metadata: { agentId: "mell", sourceFile: "test", sourceType: "session_turn", chunkIndex: 0, createdAt: Date.now() } }, score: 0.9 },
      { chunk: { id: "chunk-2", text: "田中さんのアルパカ", metadata: { agentId: "mell", sourceFile: "test", sourceType: "session_turn", chunkIndex: 1, createdAt: Date.now() } }, score: 0.85 },
    ]),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteBySource: vi.fn().mockResolvedValue(undefined),
    deleteNamespace: vi.fn().mockResolvedValue(undefined),
    ensureIndex: vi.fn().mockResolvedValue(undefined),
  };
}

describe("MemoryDeleter", () => {
  it("deleteByKeyword - dry run does not call delete", async () => {
    const mockClient = createMockClient();
    const deleter = new MemoryDeleter({ pineconeClient: mockClient, agentId: "mell", dryRun: true });

    const result = await deleter.deleteByKeyword("田中花子");

    expect(mockClient.query).toHaveBeenCalledWith(expect.objectContaining({ text: "田中花子", agentId: "mell" }));
    expect(mockClient.delete).not.toHaveBeenCalled();
    expect(result.searchedChunks).toBe(2);
    expect(result.deletedChunks).toBe(0);
    expect(result.dryRun).toBe(true);
  });

  it("deleteByKeyword - actually deletes on non-dry-run", async () => {
    const mockClient = createMockClient();
    const deleter = new MemoryDeleter({ pineconeClient: mockClient, agentId: "mell" });

    const result = await deleter.deleteByKeyword("田中花子");

    expect(mockClient.delete).toHaveBeenCalledWith(["chunk-1", "chunk-2"]);
    expect(result.deletedChunks).toBe(2);
  });

  it("deleteBySource - dry run does not call deleteBySource", async () => {
    const mockClient = createMockClient();
    const deleter = new MemoryDeleter({ pineconeClient: mockClient, agentId: "mell", dryRun: true });

    await deleter.deleteBySource("session:abc123");

    expect(mockClient.deleteBySource).not.toHaveBeenCalled();
  });

  it("deleteBySource - calls deleteBySource on non-dry-run", async () => {
    const mockClient = createMockClient();
    const deleter = new MemoryDeleter({ pineconeClient: mockClient, agentId: "mell" });

    await deleter.deleteBySource("session:abc123");

    expect(mockClient.deleteBySource).toHaveBeenCalledWith("mell", "session:abc123");
  });

  it("deleteAll - dry run does not call deleteNamespace", async () => {
    const mockClient = createMockClient();
    const deleter = new MemoryDeleter({ pineconeClient: mockClient, agentId: "mell", dryRun: true });

    await deleter.deleteAll();

    expect(mockClient.deleteNamespace).not.toHaveBeenCalled();
  });
});
