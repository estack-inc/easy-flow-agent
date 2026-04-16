import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractText,
  ingestDocument,
  ingestDocuments,
  isSupportedExtension,
} from "./ingest-document.js";

function createMockClient() {
  return {
    upsert: vi.fn<(chunks: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteBySource: vi.fn().mockResolvedValue(undefined),
    deleteNamespace: vi.fn().mockResolvedValue(undefined),
    ensureIndex: vi.fn().mockResolvedValue(undefined),
  };
}

describe("isSupportedExtension", () => {
  it("should accept .txt, .md, .markdown, .text", () => {
    expect(isSupportedExtension("file.txt")).toBe(true);
    expect(isSupportedExtension("file.md")).toBe(true);
    expect(isSupportedExtension("file.markdown")).toBe(true);
    expect(isSupportedExtension("file.text")).toBe(true);
  });

  it("should accept office and PDF files", () => {
    expect(isSupportedExtension("file.pdf")).toBe(true);
    expect(isSupportedExtension("file.docx")).toBe(true);
    expect(isSupportedExtension("file.xlsx")).toBe(true);
    expect(isSupportedExtension("file.pptx")).toBe(true);
  });

  it("should accept URLs", () => {
    expect(isSupportedExtension("https://example.com")).toBe(true);
  });

  it("should reject unsupported extensions", () => {
    expect(isSupportedExtension("file.csv")).toBe(false);
    expect(isSupportedExtension("file.jpg")).toBe(false);
  });
});

describe("extractText", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ingest-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("should read text file content", async () => {
    const filePath = join(tmpDir, "test.txt");
    await writeFile(filePath, "hello world");
    const text = await extractText(filePath);
    expect(text).toBe("hello world");
  });

  it("should read markdown file content", async () => {
    const filePath = join(tmpDir, "test.md");
    await writeFile(filePath, "# Title\n\nContent");
    const text = await extractText(filePath);
    expect(text).toBe("# Title\n\nContent");
  });

  it("should throw for unsupported file type", async () => {
    const filePath = join(tmpDir, "test.csv");
    await writeFile(filePath, "a,b,c");
    await expect(extractText(filePath)).rejects.toThrow("Unsupported file type: .csv");
  });
});

describe("ingestDocument", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ingest-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("should chunk and upsert a text file", async () => {
    const filePath = join(tmpDir, "manual.txt");
    await writeFile(filePath, "This is a test document with some content.");

    const client = createMockClient();
    const result = await ingestDocument({
      filePath,
      agentId: "test-agent",
      pgvectorClient: client,
    });

    expect(result.totalChunks).toBe(1);
    expect(result.sourceFile).toBe(`doc:${filePath}`);
    expect(result.agentId).toBe("test-agent");
    expect(client.deleteBySource).toHaveBeenCalledWith("test-agent", `doc:${filePath}`);
    // 2 upsert calls: validate + final (safe replace pattern)
    expect(client.upsert).toHaveBeenCalledTimes(2);

    const chunks = client.upsert.mock.calls[0][0];
    expect(chunks[0].metadata.sourceType).toBe("document");
    expect(chunks[0].metadata.agentId).toBe("test-agent");
  });

  it("should set category when provided", async () => {
    const filePath = join(tmpDir, "faq.md");
    await writeFile(filePath, "# FAQ\n\nQ: What? A: This.");

    const client = createMockClient();
    await ingestDocument({
      filePath,
      agentId: "test-agent",
      pgvectorClient: client,
      category: "faq",
    });

    const chunks = client.upsert.mock.calls[0][0];
    expect(chunks[0].metadata.category).toBe("faq");
  });

  it("should use custom sourceFile when provided", async () => {
    const filePath = join(tmpDir, "doc.txt");
    await writeFile(filePath, "content");

    const client = createMockClient();
    const result = await ingestDocument({
      filePath,
      agentId: "test-agent",
      pgvectorClient: client,
      sourceFile: "doc:custom-name",
    });

    expect(result.sourceFile).toBe("doc:custom-name");
  });

  it("should not upsert in dry-run mode", async () => {
    const filePath = join(tmpDir, "doc.txt");
    await writeFile(filePath, "content");

    const client = createMockClient();
    const result = await ingestDocument({
      filePath,
      agentId: "test-agent",
      pgvectorClient: client,
      dryRun: true,
    });

    expect(result.totalChunks).toBe(1);
    expect(client.upsert).not.toHaveBeenCalled();
    expect(client.deleteBySource).not.toHaveBeenCalled();
  });

  it("should validate upsert before deleting old chunks (safe replace)", async () => {
    const filePath = join(tmpDir, "doc.txt");
    await writeFile(filePath, "updated content");

    const client = createMockClient();
    await ingestDocument({
      filePath,
      agentId: "test-agent",
      pgvectorClient: client,
    });

    // Safe replace: upsert (validate) → delete → upsert (final)
    expect(client.upsert).toHaveBeenCalledTimes(2);
    expect(client.deleteBySource).toHaveBeenCalledTimes(1);
    const firstUpsertOrder = client.upsert.mock.invocationCallOrder[0];
    const deleteOrder = client.deleteBySource.mock.invocationCallOrder[0];
    const secondUpsertOrder = client.upsert.mock.invocationCallOrder[1];
    expect(firstUpsertOrder).toBeLessThan(deleteOrder);
    expect(deleteOrder).toBeLessThan(secondUpsertOrder);
  });

  it("should preserve existing data when upsert fails", async () => {
    const filePath = join(tmpDir, "doc.txt");
    await writeFile(filePath, "content");

    const client = createMockClient();
    client.upsert.mockRejectedValueOnce(new Error("Embedding API error"));

    await expect(
      ingestDocument({ filePath, agentId: "test-agent", pgvectorClient: client }),
    ).rejects.toThrow("Upsert validation failed");

    // deleteBySource should NOT have been called
    expect(client.deleteBySource).not.toHaveBeenCalled();
  });

  it("should reject documents containing secrets unless force is set", async () => {
    const filePath = join(tmpDir, "secrets.txt");
    await writeFile(filePath, "password: my_secret_pw123\nother content");

    const client = createMockClient();

    await expect(
      ingestDocument({ filePath, agentId: "test-agent", pgvectorClient: client }),
    ).rejects.toThrow("Secret detected");

    // With force, should succeed
    const result = await ingestDocument({
      filePath,
      agentId: "test-agent",
      pgvectorClient: client,
      force: true,
    });
    expect(result.totalChunks).toBeGreaterThan(0);
  });

  it("should use absolute path as sourceFile to avoid same-name collisions", async () => {
    const file1 = join(tmpDir, "sub1", "manual.txt");
    const file2 = join(tmpDir, "sub2", "manual.txt");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(tmpDir, "sub1"), { recursive: true });
    await mkdir(join(tmpDir, "sub2"), { recursive: true });
    await writeFile(file1, "content from sub1");
    await writeFile(file2, "content from sub2");

    const client = createMockClient();
    const result1 = await ingestDocument({
      filePath: file1,
      agentId: "test-agent",
      pgvectorClient: client,
    });
    const result2 = await ingestDocument({
      filePath: file2,
      agentId: "test-agent",
      pgvectorClient: client,
    });

    // Different absolute paths produce different sourceFile values
    expect(result1.sourceFile).not.toBe(result2.sourceFile);
    expect(result1.sourceFile).toContain("sub1/manual.txt");
    expect(result2.sourceFile).toContain("sub2/manual.txt");
  });

  it("should delete existing chunks and skip upsert for empty files", async () => {
    const filePath = join(tmpDir, "empty.txt");
    await writeFile(filePath, "   ");

    const client = createMockClient();
    const result = await ingestDocument({
      filePath,
      agentId: "test-agent",
      pgvectorClient: client,
    });

    expect(result.totalChunks).toBe(0);
    expect(client.upsert).not.toHaveBeenCalled();
    expect(client.deleteBySource).toHaveBeenCalledTimes(1);
  });

  it("should not delete in dry-run mode for empty files", async () => {
    const filePath = join(tmpDir, "empty.txt");
    await writeFile(filePath, "   ");

    const client = createMockClient();
    await ingestDocument({
      filePath,
      agentId: "test-agent",
      pgvectorClient: client,
      dryRun: true,
    });

    expect(client.deleteBySource).not.toHaveBeenCalled();
  });

  it("should create multiple chunks for large documents", async () => {
    const filePath = join(tmpDir, "large.txt");
    // TextChunker defaults: chunkSize=1000, overlapSize=100, step=900
    await writeFile(filePath, "x".repeat(2500));

    const client = createMockClient();
    const result = await ingestDocument({
      filePath,
      agentId: "test-agent",
      pgvectorClient: client,
    });

    expect(result.totalChunks).toBe(3); // ceil(2500/900) = 3
    expect(client.upsert).toHaveBeenCalledTimes(2); // validate + final
    expect(client.upsert.mock.calls[0][0]).toHaveLength(3);
  });
});

describe("ingestDocuments", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ingest-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("should process multiple files", async () => {
    const file1 = join(tmpDir, "doc1.txt");
    const file2 = join(tmpDir, "doc2.md");
    await writeFile(file1, "Document one content");
    await writeFile(file2, "# Document two\n\nContent here");

    const client = createMockClient();
    const { results, errors } = await ingestDocuments({
      filePaths: [file1, file2],
      agentId: "test-agent",
      pgvectorClient: client,
    });

    expect(results).toHaveLength(2);
    expect(errors).toHaveLength(0);
    expect(results[0].totalChunks).toBe(1);
    expect(results[1].totalChunks).toBe(1);
    expect(client.upsert).toHaveBeenCalledTimes(4); // 2 per file (validate + final)
  });

  it("should call ensureIndex in non-dry-run mode", async () => {
    const file1 = join(tmpDir, "doc.txt");
    await writeFile(file1, "content");

    const client = createMockClient();
    await ingestDocuments({
      filePaths: [file1],
      agentId: "test-agent",
      pgvectorClient: client,
      dryRun: false,
    });

    expect(client.ensureIndex).toHaveBeenCalledTimes(1);
  });

  it("should not call ensureIndex in dry-run mode", async () => {
    const file1 = join(tmpDir, "doc.txt");
    await writeFile(file1, "content");

    const client = createMockClient();
    await ingestDocuments({
      filePaths: [file1],
      agentId: "test-agent",
      pgvectorClient: client,
      dryRun: true,
    });

    expect(client.ensureIndex).not.toHaveBeenCalled();
  });

  it("should continue processing remaining files when one fails", async () => {
    const file1 = join(tmpDir, "doc1.txt");
    const file2 = join(tmpDir, "doc2.txt");
    await writeFile(file1, "First document");
    await writeFile(file2, "Second document");

    const client = createMockClient();
    // Make upsert fail on first call, succeed on second
    let callCount = 0;
    client.upsert.mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error("DB connection lost");
      return Promise.resolve();
    });

    const { results, errors } = await ingestDocuments({
      filePaths: [file1, file2],
      agentId: "test-agent",
      pgvectorClient: client,
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].filePath).toBe(file1);
    expect(errors[0].error.message).toContain("DB connection lost");
    expect(results).toHaveLength(1);
    expect(results[0].filePath).toBe(file2);
  });
});
