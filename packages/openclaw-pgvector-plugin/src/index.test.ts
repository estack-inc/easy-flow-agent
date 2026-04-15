import * as fs from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@easy-flow/pgvector-client", () => ({
  PgVectorClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("@easy-flow/pinecone-context-engine", () => ({
  PineconeContextEngine: vi.fn().mockImplementation(() => ({
    info: { id: "pgvector", name: "test", version: "1.0.0" },
  })),
}));

vi.mock("node:fs");

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
    vi.mocked(fs.readFileSync).mockReset();
    process.env = { ...originalEnv };
    delete process.env.PGVECTOR_DATABASE_URL;
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENCLAW_AGENT_ID;
    delete process.env.RAG_ENABLED;
    delete process.env.RAG_AGENTS_CORE_PATH;
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

  it("should pass ragEnabled and agentsCorePath from env vars", () => {
    process.env.PGVECTOR_DATABASE_URL = "postgres://test@localhost/db";
    process.env.GEMINI_API_KEY = "test-key";
    process.env.RAG_ENABLED = "true";
    process.env.RAG_AGENTS_CORE_PATH = "/data/workspace/AGENTS-CORE.md";

    const api = createMockApi();
    register(api as never);

    const factory = api.getRegisteredFactory();
    factory?.();

    expect(PineconeContextEngine).toHaveBeenCalledWith(
      expect.objectContaining({
        ragEnabled: true,
        agentsCorePath: "/data/workspace/AGENTS-CORE.md",
      }),
    );
    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("ragEnabled: true"));
  });

  it("should default ragEnabled to false when RAG_ENABLED is not set", () => {
    process.env.PGVECTOR_DATABASE_URL = "postgres://test@localhost/db";
    process.env.GEMINI_API_KEY = "test-key";

    const api = createMockApi();
    register(api as never);

    const factory = api.getRegisteredFactory();
    factory?.();

    expect(PineconeContextEngine).toHaveBeenCalledWith(
      expect.objectContaining({
        ragEnabled: false,
        agentsCorePath: undefined,
      }),
    );
    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("ragEnabled: false"));
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

  describe("config fallback from openclaw.json", () => {
    it("reads config from openclaw.json when api.pluginConfig is empty", () => {
      const fallbackConfig = JSON.stringify({
        plugins: {
          entries: {
            "pgvector-memory": {
              config: {
                databaseUrl: "postgres://fallback@localhost/db",
                geminiApiKey: "fallback-key",
                agentId: "fallback-agent",
              },
            },
          },
        },
      });
      vi.mocked(fs.readFileSync).mockReturnValue(fallbackConfig);

      const api = createMockApi();
      register(api as never);

      expect(fs.readFileSync).toHaveBeenCalledWith("/data/openclaw.json", "utf8");
      expect(api.registerContextEngine).toHaveBeenCalledWith(
        "pgvector-memory",
        expect.any(Function),
      );
      expect(api.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("agentId: fallback-agent"),
      );
    });

    it("registers context engine with fallback config values", () => {
      const fallbackConfig = JSON.stringify({
        plugins: {
          entries: {
            "pgvector-memory": {
              config: {
                databaseUrl: "postgres://fallback@localhost/db",
                geminiApiKey: "fallback-key",
                agentId: "mell",
                compactAfterDays: 14,
              },
            },
          },
        },
      });
      vi.mocked(fs.readFileSync).mockReturnValue(fallbackConfig);

      const api = createMockApi();
      register(api as never);

      const factory = api.getRegisteredFactory();
      factory?.();

      expect(PgVectorClient).toHaveBeenCalledWith({
        databaseUrl: "postgres://fallback@localhost/db",
        geminiApiKey: "fallback-key",
      });
      expect(PineconeContextEngine).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "mell",
          compactAfterDays: 14,
        }),
      );
    });

    it("does not read openclaw.json when api.pluginConfig has values", () => {
      const api = createMockApi({
        databaseUrl: "postgres://config@localhost/db",
        geminiApiKey: "config-key",
      });
      register(api as never);

      expect(fs.readFileSync).not.toHaveBeenCalled();
    });

    it("disables plugin gracefully when openclaw.json read fails", () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error("ENOENT: no such file or directory");
      });

      const api = createMockApi();
      register(api as never);

      expect(api.logger.debug).toHaveBeenCalledWith(
        expect.stringContaining("readConfigFallback failed"),
      );
      expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining("plugin disabled"));
      expect(api.registerContextEngine).not.toHaveBeenCalled();
    });

    it("disables plugin when openclaw.json has no pgvector-memory entry", () => {
      const fallbackConfig = JSON.stringify({
        plugins: { entries: {} },
      });
      vi.mocked(fs.readFileSync).mockReturnValue(fallbackConfig);

      const api = createMockApi();
      register(api as never);

      expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining("plugin disabled"));
      expect(api.registerContextEngine).not.toHaveBeenCalled();
    });
  });
});
