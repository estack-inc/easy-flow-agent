import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@easy-flow/pgvector-client", () => ({
  PgVectorClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("@easy-flow/pinecone-context-engine", () => ({
  PineconeContextEngine: vi.fn().mockImplementation(() => ({
    info: { id: "pgvector", name: "test", version: "1.0.0" },
  })),
}));

import { PgVectorClient } from "@easy-flow/pgvector-client";
import { PineconeContextEngine } from "@easy-flow/pinecone-context-engine";
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

describe("openclaw-pgvector-plugin", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.PGVECTOR_DATABASE_URL;
    delete process.env.GEMINI_API_KEY;
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
    process.env.PGVECTOR_DATABASE_URL = "postgres://test:test@localhost:5432/test";
    process.env.GEMINI_API_KEY = "test-key";
    process.env.OPENCLAW_AGENT_ID = "mell";

    const api = createMockApi();

    register(api as never);

    expect(api.registerContextEngine).toHaveBeenCalledWith("pgvector-memory", expect.any(Function));
    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("agentId: mell"));
  });

  it("should register context engine with plugin config", () => {
    const api = createMockApi({
      databaseUrl: "postgres://config@localhost/db",
      geminiApiKey: "config-key",
      agentId: "tom",
      compactAfterDays: 14,
    });

    register(api as never);

    const factory = api.getRegisteredFactory();
    factory?.();

    expect(PgVectorClient).toHaveBeenCalledWith({
      databaseUrl: "postgres://config@localhost/db",
      geminiApiKey: "config-key",
    });
    expect(PineconeContextEngine).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "tom",
        compactAfterDays: 14,
      }),
    );
  });

  it("should use default agentId when not specified", () => {
    process.env.PGVECTOR_DATABASE_URL = "postgres://test@localhost/db";
    process.env.GEMINI_API_KEY = "test-key";

    const api = createMockApi();

    register(api as never);

    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("agentId: default"));
  });

  it("should prefer plugin config over env vars", () => {
    process.env.PGVECTOR_DATABASE_URL = "postgres://env@localhost/db";
    process.env.GEMINI_API_KEY = "env-key";

    const api = createMockApi({
      databaseUrl: "postgres://config@localhost/db",
      geminiApiKey: "config-key",
    });

    register(api as never);

    const factory = api.getRegisteredFactory();
    factory?.();

    expect(PgVectorClient).toHaveBeenCalledWith({
      databaseUrl: "postgres://config@localhost/db",
      geminiApiKey: "config-key",
    });
  });
});
