import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PineconeClient } from "./client.js";

const SKIP = !process.env.PINECONE_INTEGRATION;
const describeIntegration = SKIP ? describe.skip : describe;

describeIntegration("PineconeClient Integration", () => {
  let client: PineconeClient;
  const agentId = `test-integration-${Date.now()}`;

  beforeAll(async () => {
    client = new PineconeClient({ apiKey: process.env.PINECONE_API_KEY! });
    await client.ensureIndex();
  }, 60000);

  afterAll(async () => {
    await client.deleteNamespace(agentId);
  }, 30000);

  it("upserts and queries chunks", async () => {
    const { TextChunker } = await import("./chunker.js");
    const chunker = new TextChunker();

    const chunks = chunker.chunk({
      text: "TypeScript is a typed superset of JavaScript that compiles to plain JavaScript.",
      agentId,
      sourceFile: "test-doc.md",
      sourceType: "memory_file",
    });

    await client.upsert(chunks);

    // Wait for indexing
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const results = await client.query({
      text: "What is TypeScript?",
      agentId,
      topK: 5,
      minScore: 0.5,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk.text).toContain("TypeScript");
  }, 30000);

  it("deleteBySource removes only target chunks", async () => {
    const { TextChunker } = await import("./chunker.js");
    const chunker = new TextChunker();

    const chunks1 = chunker.chunk({
      text: "Source A content for deletion test.",
      agentId,
      sourceFile: "source-a.md",
      sourceType: "memory_file",
    });

    const chunks2 = chunker.chunk({
      text: "Source B content should remain after deletion.",
      agentId,
      sourceFile: "source-b.md",
      sourceType: "memory_file",
    });

    await client.upsert([...chunks1, ...chunks2]);

    // Wait for indexing
    await new Promise((resolve) => setTimeout(resolve, 3000));

    await client.deleteBySource(agentId, "source-a.md");

    // Wait for deletion
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const results = await client.query({
      text: "content",
      agentId,
      topK: 10,
      minScore: 0.3,
    });

    const sourceFiles = results.map((r) => r.chunk.metadata.sourceFile);
    expect(sourceFiles).not.toContain("source-a.md");
  }, 30000);
});
