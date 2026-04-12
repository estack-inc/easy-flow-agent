import { beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiEmbeddingService } from "./embedding.js";

const mockBatchEmbedContents = vi.fn();

vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
    getGenerativeModel: () => ({
      batchEmbedContents: mockBatchEmbedContents,
    }),
  })),
  TaskType: {
    RETRIEVAL_DOCUMENT: "RETRIEVAL_DOCUMENT",
    RETRIEVAL_QUERY: "RETRIEVAL_QUERY",
  },
}));

describe("GeminiEmbeddingService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return empty array for empty input", async () => {
    const service = new GeminiEmbeddingService("test-key");
    const result = await service.embed([], "RETRIEVAL_DOCUMENT" as never);

    expect(result).toEqual([]);
    expect(mockBatchEmbedContents).not.toHaveBeenCalled();
  });

  it("should embed a single text", async () => {
    mockBatchEmbedContents.mockResolvedValueOnce({
      embeddings: [{ values: [0.1, 0.2, 0.3] }],
    });

    const service = new GeminiEmbeddingService("test-key");
    const result = await service.embed(["hello"], "RETRIEVAL_DOCUMENT" as never);

    expect(result).toEqual([[0.1, 0.2, 0.3]]);
    expect(mockBatchEmbedContents).toHaveBeenCalledTimes(1);
    expect(mockBatchEmbedContents).toHaveBeenCalledWith({
      requests: [
        {
          content: { role: "user", parts: [{ text: "hello" }] },
          taskType: "RETRIEVAL_DOCUMENT",
        },
      ],
    });
  });

  it("should batch texts when exceeding BATCH_SIZE (96)", async () => {
    const texts = Array.from({ length: 100 }, (_, i) => `text-${i}`);
    const batch1Embeddings = Array.from({ length: 96 }, () => ({ values: [0.1] }));
    const batch2Embeddings = Array.from({ length: 4 }, () => ({ values: [0.2] }));

    mockBatchEmbedContents
      .mockResolvedValueOnce({ embeddings: batch1Embeddings })
      .mockResolvedValueOnce({ embeddings: batch2Embeddings });

    const service = new GeminiEmbeddingService("test-key");
    const result = await service.embed(texts, "RETRIEVAL_QUERY" as never);

    expect(result).toHaveLength(100);
    expect(mockBatchEmbedContents).toHaveBeenCalledTimes(2);

    // First batch: 96 texts
    const firstCall = mockBatchEmbedContents.mock.calls[0][0];
    expect(firstCall.requests).toHaveLength(96);

    // Second batch: 4 texts
    const secondCall = mockBatchEmbedContents.mock.calls[1][0];
    expect(secondCall.requests).toHaveLength(4);

    // Verify results are concatenated in order
    expect(result.slice(0, 96).every((v: number[]) => v[0] === 0.1)).toBe(true);
    expect(result.slice(96).every((v: number[]) => v[0] === 0.2)).toBe(true);
  });

  it("should have DIMENSIONS = 768", () => {
    expect(GeminiEmbeddingService.DIMENSIONS).toBe(768);
  });
});
