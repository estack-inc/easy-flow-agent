import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { Migrator } from "./migrator.js";
import type { IPineconeClient, MemoryChunk } from "@easy-flow/pinecone-client";

function createMockClient(): IPineconeClient & {
  [K in keyof IPineconeClient]: Mock;
} {
  return {
    upsert: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteBySource: vi.fn().mockResolvedValue(undefined),
    deleteNamespace: vi.fn().mockResolvedValue(undefined),
    ensureIndex: vi.fn().mockResolvedValue(undefined),
  } as IPineconeClient & { [K in keyof IPineconeClient]: Mock };
}

describe("Migrator", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not call upsert in dry-run mode", async () => {
    const client = createMockClient();
    const migrator = new Migrator({
      pineconeClient: client,
      agentId: "test-agent",
      dryRun: true,
    });

    const file = path.join(tmpDir, "MEMORY.md");
    fs.writeFileSync(file, "# Memory\n\nSome content here.", "utf-8");

    const result = await migrator.migrate([file]);

    expect(result.processedFiles).toBe(1);
    expect(result.totalChunks).toBeGreaterThan(0);
    expect(result.upsertedChunks).toBe(0);
    expect(client.upsert).not.toHaveBeenCalled();
  });

  it("calls upsert when not in dry-run mode", async () => {
    const client = createMockClient();
    const migrator = new Migrator({
      pineconeClient: client,
      agentId: "test-agent",
      dryRun: false,
    });

    const file = path.join(tmpDir, "MEMORY.md");
    fs.writeFileSync(file, "# Memory\n\nSome content here.", "utf-8");

    const result = await migrator.migrate([file]);

    expect(result.processedFiles).toBe(1);
    expect(result.totalChunks).toBeGreaterThan(0);
    expect(result.upsertedChunks).toBe(result.totalChunks);
    expect(client.upsert).toHaveBeenCalledOnce();

    const chunks = client.upsert.mock.calls[0][0] as MemoryChunk[];
    expect(chunks[0].metadata.sourceType).toBe("memory_file");
  });

  it("recursively scans directories for .md files only", async () => {
    const client = createMockClient();
    const migrator = new Migrator({
      pineconeClient: client,
      agentId: "test-agent",
    });

    // Create nested structure
    const subDir = path.join(tmpDir, "sub");
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(tmpDir, "root.md"), "root content", "utf-8");
    fs.writeFileSync(path.join(subDir, "nested.md"), "nested content", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "ignored.txt"), "should skip", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "ignored.json"), "{}", "utf-8");

    const result = await migrator.migrate([tmpDir]);

    expect(result.processedFiles).toBe(2);
    expect(client.upsert).toHaveBeenCalledTimes(2);
  });

  it("continues processing after a file error", async () => {
    const client = createMockClient();
    // Fail on the first upsert, succeed on the second
    client.upsert
      .mockRejectedValueOnce(new Error("Pinecone down"))
      .mockResolvedValueOnce(undefined);

    const migrator = new Migrator({
      pineconeClient: client,
      agentId: "test-agent",
    });

    const file1 = path.join(tmpDir, "file1.md");
    const file2 = path.join(tmpDir, "file2.md");
    fs.writeFileSync(file1, "content 1", "utf-8");
    fs.writeFileSync(file2, "content 2", "utf-8");

    const result = await migrator.migrate([file1, file2]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].file).toBe(file1);
    expect(result.errors[0].error).toBe("Pinecone down");
    // file2 should still be processed
    expect(result.processedFiles).toBe(1);
    expect(result.upsertedChunks).toBeGreaterThan(0);
  });

  it("correctly counts processedFiles and totalChunks", async () => {
    const client = createMockClient();
    const migrator = new Migrator({
      pineconeClient: client,
      agentId: "test-agent",
    });

    const file1 = path.join(tmpDir, "small.md");
    const file2 = path.join(tmpDir, "large.md");
    fs.writeFileSync(file1, "small file", "utf-8");
    // Create a file that produces multiple chunks (>1000 chars)
    fs.writeFileSync(file2, "A".repeat(2500), "utf-8");

    const result = await migrator.migrate([file1, file2]);

    expect(result.processedFiles).toBe(2);
    // small.md = 1 chunk, large.md = multiple chunks
    expect(result.totalChunks).toBeGreaterThanOrEqual(3);
    expect(result.upsertedChunks).toBe(result.totalChunks);
  });

  it("excludes files matching excludePatterns", async () => {
    const client = createMockClient();
    const migrator = new Migrator({
      pineconeClient: client,
      agentId: "test-agent",
      excludePatterns: ["**/bank-accounts.md", "**/employees/**"],
    });

    // Create files — some should be excluded
    const subDir = path.join(tmpDir, "employees");
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(tmpDir, "normal.md"), "normal content", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "bank-accounts.md"), "secret", "utf-8");
    fs.writeFileSync(path.join(subDir, "staff.md"), "employee data", "utf-8");

    const result = await migrator.migrate([tmpDir]);

    // Only normal.md should be processed
    expect(result.processedFiles).toBe(1);
    expect(client.upsert).toHaveBeenCalledTimes(1);
  });

  it("skips empty files", async () => {
    const client = createMockClient();
    const migrator = new Migrator({
      pineconeClient: client,
      agentId: "test-agent",
    });

    const file = path.join(tmpDir, "empty.md");
    fs.writeFileSync(file, "", "utf-8");

    const result = await migrator.migrate([file]);

    expect(result.processedFiles).toBe(0);
    expect(result.skippedFiles).toContain(file);
    expect(client.upsert).not.toHaveBeenCalled();
  });
});
