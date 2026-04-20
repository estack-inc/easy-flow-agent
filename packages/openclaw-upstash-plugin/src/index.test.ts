import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("@easy-flow/upstash-vector-client", () => ({
  UpstashVectorClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("@easy-flow/pinecone-context-engine", () => ({
  PineconeContextEngine: vi.fn().mockImplementation(() => ({
    info: { id: "pinecone", name: "test", version: "1.0.0" },
  })),
}));

import { PineconeContextEngine } from "@easy-flow/pinecone-context-engine";
import { UpstashVectorClient } from "@easy-flow/upstash-vector-client";
import register from "./index.js";

function createMockApi(config: Record<string, unknown> = {}) {
  let registeredFactory: (() => unknown) | null = null;

  return {
    pluginConfig: config,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerContextEngine: vi.fn((_name: string, factory: () => unknown) => {
      registeredFactory = factory;
    }),
    getRegisteredFactory: () => registeredFactory,
  };
}

describe("openclaw-upstash-plugin", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.UPSTASH_VECTOR_REST_URL;
    delete process.env.UPSTASH_VECTOR_REST_TOKEN;
    delete process.env.OPENCLAW_AGENT_ID;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("should disable plugin when credentials are missing", () => {
    const api = createMockApi();

    register(api as never);

    expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining("plugin disabled"));
    expect(api.registerContextEngine).not.toHaveBeenCalled();
  });

  it("should register context engine with env vars", () => {
    process.env.UPSTASH_VECTOR_REST_URL = "https://test.upstash.io";
    process.env.UPSTASH_VECTOR_REST_TOKEN = "test-token";
    process.env.OPENCLAW_AGENT_ID = "mell";

    const api = createMockApi();

    register(api as never);

    expect(api.registerContextEngine).toHaveBeenCalledWith("upstash-memory", expect.any(Function));
    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("agentId: mell"));
  });

  it("should register context engine with plugin config", () => {
    const api = createMockApi({
      url: "https://config.upstash.io",
      token: "config-token",
      agentId: "tom",
      compactAfterDays: 14,
    });

    register(api as never);

    expect(api.registerContextEngine).toHaveBeenCalledWith("upstash-memory", expect.any(Function));

    // Invoke the factory
    const factory = api.getRegisteredFactory();
    factory?.();

    expect(UpstashVectorClient).toHaveBeenCalledWith({
      url: "https://config.upstash.io",
      token: "config-token",
    });
    expect(PineconeContextEngine).toHaveBeenCalledWith(
      expect.objectContaining({
        info: expect.objectContaining({ id: "upstash-memory" }),
        agentId: "tom",
        compactAfterDays: 14,
      }),
    );
  });

  it("should use default agentId when not specified", () => {
    process.env.UPSTASH_VECTOR_REST_URL = "https://test.upstash.io";
    process.env.UPSTASH_VECTOR_REST_TOKEN = "test-token";

    const api = createMockApi();

    register(api as never);

    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("agentId: default"));
  });

  it("should prefer plugin config over env vars", () => {
    process.env.UPSTASH_VECTOR_REST_URL = "https://env.upstash.io";
    process.env.UPSTASH_VECTOR_REST_TOKEN = "env-token";

    const api = createMockApi({
      url: "https://config.upstash.io",
      token: "config-token",
    });

    register(api as never);

    const factory = api.getRegisteredFactory();
    factory?.();

    expect(UpstashVectorClient).toHaveBeenCalledWith({
      url: "https://config.upstash.io",
      token: "config-token",
    });
  });
});
