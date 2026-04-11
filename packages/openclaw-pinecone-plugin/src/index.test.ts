import { describe, expect, it, vi } from "vitest";

vi.mock("@easy-flow/pinecone-client", () => ({
  PineconeClient: vi.fn().mockImplementation((config) => ({
    _config: config,
  })),
}));

vi.mock("@easy-flow/pinecone-context-engine", () => ({
  PineconeContextEngine: vi.fn().mockImplementation((params) => ({
    _params: params,
    assemble: vi.fn(),
    ingest: vi.fn(),
  })),
}));

import { PineconeClient } from "@easy-flow/pinecone-client";
import { PineconeContextEngine } from "@easy-flow/pinecone-context-engine";
import register from "./index.js";

function createMockApi(pluginConfig: Record<string, unknown> = {}) {
  return {
    id: "pinecone-memory",
    name: "Pinecone Memory",
    source: "test",
    pluginConfig,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerContextEngine: vi.fn(),
    resolvePath: (p: string) => p,
    on: vi.fn(),
  };
}

describe("pinecone-memory plugin", () => {
  it("warns and does not register when API key is missing", () => {
    const originalEnv = process.env.PINECONE_API_KEY;
    delete process.env.PINECONE_API_KEY;

    const api = createMockApi({});
    register(api as any);

    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("PINECONE_API_KEY not set"),
    );
    expect(api.registerContextEngine).not.toHaveBeenCalled();

    if (originalEnv === undefined) {
      delete process.env.PINECONE_API_KEY;
    } else {
      process.env.PINECONE_API_KEY = originalEnv;
    }
  });

  it("registers context engine with API key from pluginConfig", () => {
    const api = createMockApi({ apiKey: "test-key", agentId: "mell" });
    register(api as any);

    expect(api.registerContextEngine).toHaveBeenCalledWith("pinecone-memory", expect.any(Function));
    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("agentId: mell"));
  });

  it("registers context engine with API key from env var", () => {
    const originalEnv = process.env.PINECONE_API_KEY;
    process.env.PINECONE_API_KEY = "env-key";

    const api = createMockApi({});
    register(api as any);

    expect(api.registerContextEngine).toHaveBeenCalledWith("pinecone-memory", expect.any(Function));

    if (originalEnv === undefined) {
      delete process.env.PINECONE_API_KEY;
    } else {
      process.env.PINECONE_API_KEY = originalEnv;
    }
  });

  it("uses default agentId when not specified", () => {
    const api = createMockApi({ apiKey: "test-key" });
    register(api as any);

    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("agentId: default"));
  });

  it("uses custom indexName, compactAfterDays, and logs mode: classic", () => {
    const api = createMockApi({
      apiKey: "test-key",
      agentId: "mell",
      indexName: "custom-index",
      compactAfterDays: 14,
    });
    register(api as any);

    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("index: custom-index"));
    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("mode: classic"));
    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("compactAfterDays: 14"));
  });

  it("passes memoryHint and minQueryTokens to PineconeContextEngine", () => {
    const api = createMockApi({
      apiKey: "test-key",
      agentId: "mell",
      memoryHint: "eSTACK AI agent",
      minQueryTokens: 30,
    });
    register(api as any);

    const factory = api.registerContextEngine.mock.calls[0][1];
    factory();

    expect(PineconeContextEngine).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "mell",
        memoryHint: "eSTACK AI agent",
        minQueryTokens: 30,
      }),
    );
  });

  it("factory creates PineconeContextEngine with correct params", () => {
    const api = createMockApi({
      apiKey: "test-key",
      agentId: "mell",
      indexName: "custom-index",
      compactAfterDays: 14,
    });
    register(api as any);

    const factory = api.registerContextEngine.mock.calls[0][1];
    const engine = factory();

    expect(PineconeClient).toHaveBeenCalledWith({
      apiKey: "test-key",
      indexName: "custom-index",
    });
    expect(PineconeContextEngine).toHaveBeenCalledWith(
      expect.objectContaining({
        pineconeClient: expect.objectContaining({
          _config: { apiKey: "test-key", indexName: "custom-index" },
        }),
        agentId: "mell",
        compactAfterDays: 14,
        ragEnabled: false,
      }),
    );
    expect(engine).toBeDefined();
  });

  it("ignores NaN from invalid env var values and falls back to undefined", () => {
    const originalBudget = process.env.RAG_TOKEN_BUDGET;
    const originalScore = process.env.RAG_MIN_SCORE;
    const originalTopK = process.env.RAG_TOP_K;

    process.env.RAG_TOKEN_BUDGET = "abc";
    process.env.RAG_MIN_SCORE = "not-a-number";
    process.env.RAG_TOP_K = "";

    const api = createMockApi({ apiKey: "test-key", agentId: "mell" });
    register(api as any);

    const factory = api.registerContextEngine.mock.calls[0][1];
    factory();

    expect(PineconeContextEngine).toHaveBeenCalledWith(
      expect.objectContaining({
        ragTokenBudget: undefined,
        ragMinScore: undefined,
        ragTopK: undefined,
      }),
    );

    if (originalBudget === undefined) {
      delete process.env.RAG_TOKEN_BUDGET;
    } else {
      process.env.RAG_TOKEN_BUDGET = originalBudget;
    }
    if (originalScore === undefined) {
      delete process.env.RAG_MIN_SCORE;
    } else {
      process.env.RAG_MIN_SCORE = originalScore;
    }
    if (originalTopK === undefined) {
      delete process.env.RAG_TOP_K;
    } else {
      process.env.RAG_TOP_K = originalTopK;
    }
  });

  it("rounds float RAG_TOP_K env var to integer", () => {
    const originalTopK = process.env.RAG_TOP_K;

    process.env.RAG_TOP_K = "5.7";

    const api = createMockApi({ apiKey: "test-key", agentId: "mell" });
    register(api as any);

    const factory = api.registerContextEngine.mock.calls[0][1];
    factory();

    expect(PineconeContextEngine).toHaveBeenCalledWith(
      expect.objectContaining({
        ragTopK: 6,
      }),
    );

    if (originalTopK === undefined) {
      delete process.env.RAG_TOP_K;
    } else {
      process.env.RAG_TOP_K = originalTopK;
    }
  });
});
