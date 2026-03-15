import { describe, expect, it, vi } from "vitest";
import { EmbeddingService } from "./embedding.js";

function createMockPinecone(embedFn: (...args: unknown[]) => unknown) {
  return {
    inference: {
      embed: embedFn,
    },
  } as any;
}

function createFakeEmbedding(dim = 1024): number[] {
  return Array.from({ length: dim }, (_, i) => i * 0.001);
}

describe("EmbeddingService", () => {
  it("returns empty array for empty input", async () => {
    const mockPinecone = createMockPinecone(vi.fn());
    const service = new EmbeddingService(mockPinecone);

    const result = await service.embed([], "passage");
    expect(result).toEqual([]);
  });

  it("calls pinecone.inference.embed with correct parameters", async () => {
    const fakeEmbedding = createFakeEmbedding();
    const embedFn = vi.fn().mockResolvedValue({ data: [{ values: fakeEmbedding }] });
    const mockPinecone = createMockPinecone(embedFn);
    const service = new EmbeddingService(mockPinecone);

    const result = await service.embed(["Hello world"], "query");

    expect(embedFn).toHaveBeenCalledWith({
      model: "multilingual-e5-large",
      inputs: ["Hello world"],
      parameters: { input_type: "query", truncate: "END" },
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(fakeEmbedding);
  });

  it("handles multiple texts in a single batch", async () => {
    const fakeEmbedding = createFakeEmbedding();
    const embedFn = vi.fn().mockResolvedValue({
      data: [{ values: fakeEmbedding }, { values: fakeEmbedding }, { values: fakeEmbedding }],
    });
    const mockPinecone = createMockPinecone(embedFn);
    const service = new EmbeddingService(mockPinecone);

    const result = await service.embed(["text1", "text2", "text3"], "passage");

    expect(embedFn).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(3);
  });

  it("auto-splits into batches when exceeding BATCH_SIZE", async () => {
    const fakeEmbedding = createFakeEmbedding();
    const embedFn = vi
      .fn()
      .mockImplementation((params: { inputs: string[] }) =>
        Promise.resolve({ data: params.inputs.map(() => ({ values: fakeEmbedding })) }),
      );
    const mockPinecone = createMockPinecone(embedFn);
    const service = new EmbeddingService(mockPinecone);

    const texts = Array.from({ length: 200 }, (_, i) => `text-${i}`);
    const result = await service.embed(texts, "passage");

    // 200 texts / 96 batch = 3 calls (96 + 96 + 8)
    expect(embedFn).toHaveBeenCalledTimes(3);
    expect(result).toHaveLength(200);

    // Verify batch sizes
    expect(embedFn.mock.calls[0][0].inputs).toHaveLength(96);
    expect(embedFn.mock.calls[1][0].inputs).toHaveLength(96);
    expect(embedFn.mock.calls[2][0].inputs).toHaveLength(8);
  });

  it("passes inputType correctly for passage and query", async () => {
    const fakeEmbedding = createFakeEmbedding();
    const embedFn = vi.fn().mockResolvedValue({ data: [{ values: fakeEmbedding }] });
    const mockPinecone = createMockPinecone(embedFn);
    const service = new EmbeddingService(mockPinecone);

    await service.embed(["passage text"], "passage");
    expect(embedFn).toHaveBeenCalledWith({
      model: "multilingual-e5-large",
      inputs: ["passage text"],
      parameters: { input_type: "passage", truncate: "END" },
    });

    await service.embed(["query text"], "query");
    expect(embedFn).toHaveBeenCalledWith({
      model: "multilingual-e5-large",
      inputs: ["query text"],
      parameters: { input_type: "query", truncate: "END" },
    });
  });

  it("has BATCH_SIZE of 96", () => {
    expect(EmbeddingService.BATCH_SIZE).toBe(96);
  });
});
