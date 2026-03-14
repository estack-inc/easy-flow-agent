import { describe, expect, it, vi } from "vitest";
import { TextChunker } from "./chunker.js";

describe("TextChunker", () => {
  it("returns empty array for empty text", () => {
    const chunker = new TextChunker();
    const result = chunker.chunk({
      text: "",
      agentId: "mell",
      sourceFile: "MEMORY.md",
      sourceType: "memory_file",
    });
    expect(result).toEqual([]);
  });

  it("returns single chunk for short text", () => {
    const chunker = new TextChunker();
    const text = "Hello world";
    const result = chunker.chunk({
      text,
      agentId: "mell",
      sourceFile: "MEMORY.md",
      sourceType: "memory_file",
    });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("mell:MEMORY.md:0");
    expect(result[0].text).toBe(text);
    expect(result[0].metadata.agentId).toBe("mell");
    expect(result[0].metadata.sourceFile).toBe("MEMORY.md");
    expect(result[0].metadata.sourceType).toBe("memory_file");
    expect(result[0].metadata.chunkIndex).toBe(0);
  });

  it("splits text into overlapping chunks with default settings", () => {
    const chunker = new TextChunker();
    // Create text of 2050 characters
    const text = "a".repeat(2050);
    const result = chunker.chunk({
      text,
      agentId: "mell",
      sourceFile: "notes.md",
      sourceType: "memory_file",
    });

    // chunkSize=1000, overlap=100, step=900
    // chunk 0: 0-1000 (1000 chars)
    // chunk 1: 900-1900 (1000 chars)
    // chunk 2: 1800-2050 (250 chars)
    expect(result).toHaveLength(3);
    expect(result[0].text).toHaveLength(1000);
    expect(result[1].text).toHaveLength(1000);
    expect(result[2].text).toHaveLength(250);

    // Verify overlap: last 100 chars of chunk 0 === first 100 chars of chunk 1
    expect(result[0].text.slice(900)).toBe(result[1].text.slice(0, 100));
  });

  it("assigns sequential chunk indices", () => {
    const chunker = new TextChunker({ chunkSize: 100, overlapSize: 10 });
    const text = "x".repeat(300);
    const result = chunker.chunk({
      text,
      agentId: "agent1",
      sourceFile: "file.md",
      sourceType: "memory_file",
    });

    result.forEach((chunk, i) => {
      expect(chunk.metadata.chunkIndex).toBe(i);
      expect(chunk.id).toBe(`agent1:file.md:${i}`);
    });
  });

  it("respects custom chunkSize and overlapSize", () => {
    const chunker = new TextChunker({ chunkSize: 50, overlapSize: 10 });
    const text = "b".repeat(120);
    const result = chunker.chunk({
      text,
      agentId: "test",
      sourceFile: "test.md",
      sourceType: "memory_file",
    });

    // step=40
    // chunk 0: 0-50 (50 chars)
    // chunk 1: 40-90 (50 chars)
    // chunk 2: 80-120 (40 chars)
    expect(result).toHaveLength(3);
    expect(result[0].text).toHaveLength(50);
    expect(result[1].text).toHaveLength(50);
    expect(result[2].text).toHaveLength(40);
  });

  it("includes optional turnId and role in metadata", () => {
    const chunker = new TextChunker();
    const result = chunker.chunk({
      text: "user message",
      agentId: "mell",
      sourceFile: "session:abc123",
      sourceType: "session_turn",
      turnId: "turn-1",
      role: "user",
    });

    expect(result[0].metadata.turnId).toBe("turn-1");
    expect(result[0].metadata.role).toBe("user");
  });

  it("omits turnId and role when not provided", () => {
    const chunker = new TextChunker();
    const result = chunker.chunk({
      text: "some text",
      agentId: "mell",
      sourceFile: "MEMORY.md",
      sourceType: "memory_file",
    });

    expect(result[0].metadata).not.toHaveProperty("turnId");
    expect(result[0].metadata).not.toHaveProperty("role");
  });

  it("sets createdAt to current timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T00:00:00Z"));

    const chunker = new TextChunker();
    const result = chunker.chunk({
      text: "test",
      agentId: "mell",
      sourceFile: "MEMORY.md",
      sourceType: "memory_file",
    });

    expect(result[0].metadata.createdAt).toBe(
      new Date("2026-03-14T00:00:00Z").getTime(),
    );

    vi.useRealTimers();
  });

  it("handles text exactly equal to chunkSize", () => {
    const chunker = new TextChunker({ chunkSize: 100, overlapSize: 10 });
    const text = "c".repeat(100);
    const result = chunker.chunk({
      text,
      agentId: "test",
      sourceFile: "test.md",
      sourceType: "memory_file",
    });

    expect(result).toHaveLength(1);
    expect(result[0].text).toHaveLength(100);
  });
});
