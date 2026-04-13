import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@easy-flow/pgvector-client", () => ({
  PgVectorClient: vi.fn().mockImplementation(() => ({ _type: "pgvector" })),
}));

vi.mock("@easy-flow/pinecone-client", () => ({
  PineconeClient: vi.fn().mockImplementation(() => ({ _type: "pinecone" })),
}));

import { createClient } from "./create-client.js";

describe("createClient", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("should return noopClient when dryRun is true", () => {
    const client = createClient("pgvector", true);
    expect(client).toBeDefined();
    expect(client.upsert).toBeTypeOf("function");
    expect(client.query).toBeTypeOf("function");
    expect(client.delete).toBeTypeOf("function");
  });

  it("should exit with error when backend is invalid", () => {
    expect(() => createClient("redis" as never, false)).toThrow("process.exit");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Invalid --backend value "redis"'),
    );
  });

  it("should exit when PGVECTOR_DATABASE_URL is missing for pgvector backend", () => {
    delete process.env.PGVECTOR_DATABASE_URL;
    process.env.GEMINI_API_KEY = "test-key";
    expect(() => createClient("pgvector", false)).toThrow("process.exit");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("PGVECTOR_DATABASE_URL"));
  });

  it("should exit when GEMINI_API_KEY is missing for pgvector backend", () => {
    process.env.PGVECTOR_DATABASE_URL = "postgresql://localhost/test";
    delete process.env.GEMINI_API_KEY;
    expect(() => createClient("pgvector", false)).toThrow("process.exit");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("GEMINI_API_KEY"));
  });

  it("should exit when PINECONE_API_KEY is missing for pinecone backend", () => {
    delete process.env.PINECONE_API_KEY;
    expect(() => createClient("pinecone", false)).toThrow("process.exit");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("PINECONE_API_KEY"));
  });

  it("should create PgVectorClient when pgvector env vars are set", () => {
    process.env.PGVECTOR_DATABASE_URL = "postgresql://localhost/test";
    process.env.GEMINI_API_KEY = "test-key";
    const client = createClient("pgvector", false);
    expect(client).toBeDefined();
  });

  it("should create PineconeClient when pinecone env vars are set", () => {
    process.env.PINECONE_API_KEY = "test-key";
    const client = createClient("pinecone", false);
    expect(client).toBeDefined();
  });
});
