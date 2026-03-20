import { afterEach, describe, expect, it, vi } from "vitest";
import workflowControllerPlugin from "./src/index.js";

vi.mock("@easy-flow/pinecone-client", () => ({
  PineconeClient: vi.fn().mockImplementation((config: { apiKey: string; indexName?: string }) => ({
    _apiKey: config.apiKey,
    _indexName: config.indexName,
    upsert: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteBySource: vi.fn().mockResolvedValue(undefined),
    deleteNamespace: vi.fn().mockResolvedValue(undefined),
    ensureIndex: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@easy-flow/pinecone-context-engine", () => ({
  PineconeContextEngine: vi.fn().mockImplementation(() => ({
    info: { id: "pinecone-memory", name: "Pinecone Memory", version: "0.1.0" },
    ingest: vi.fn().mockResolvedValue({ ingested: true }),
    assemble: vi.fn().mockResolvedValue({ messages: [], estimatedTokens: 0 }),
    compact: vi.fn().mockResolvedValue({ ok: true, compacted: false }),
  })),
}));

vi.mock("openclaw/plugin-sdk/core", () => ({
  emptyPluginConfigSchema: vi.fn(() => ({
    type: "object",
    additionalProperties: false,
    properties: {
      pineconeApiKey: { type: "string" },
      agentId: { type: "string" },
      indexName: { type: "string" },
      compactAfterDays: { type: "number", minimum: 1, maximum: 90 },
    },
  })),
}));

function createMockApi(pluginConfig: Record<string, unknown> = {}) {
  const contextEngineFactories = new Map<string, () => Promise<unknown>>();
  const toolFactories: Array<{ factory: unknown; opts: unknown }> = [];

  return {
    pluginConfig,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerContextEngine: vi.fn((id: string, factory: () => Promise<unknown>) => {
      contextEngineFactories.set(id, factory);
    }),
    registerTool: vi.fn((factory: unknown, opts: unknown) => {
      toolFactories.push({ factory, opts });
    }),
    // テストヘルパー
    _contextEngineFactories: contextEngineFactories,
    _toolFactories: toolFactories,
  };
}

describe("workflowControllerPlugin", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  describe("plugin metadata", () => {
    it("has correct id and kind", () => {
      expect(workflowControllerPlugin.id).toBe("workflow-controller");
      expect(workflowControllerPlugin.kind).toBe("context-engine");
    });

    it("configSchema matches PluginConfig fields", () => {
      const schema = workflowControllerPlugin.configSchema;
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      expect(schema.properties).toHaveProperty("pineconeApiKey");
      expect(schema.properties).toHaveProperty("agentId");
      expect(schema.properties).toHaveProperty("indexName");
      expect(schema.properties).toHaveProperty("compactAfterDays");
      expect(schema.properties.compactAfterDays).toMatchObject({
        type: "number",
        minimum: 1,
        maximum: 90,
      });
    });
  });

  describe("register()", () => {
    it("registers context engine and tools", () => {
      const api = createMockApi();
      workflowControllerPlugin.register(api as any);

      expect(api.registerContextEngine).toHaveBeenCalledWith("workflow", expect.any(Function));
      expect(api.registerTool).toHaveBeenCalledOnce();
    });

    describe("Pinecone enabled path", () => {
      it("creates PineconeClient when pineconeApiKey is in pluginConfig", async () => {
        const { PineconeClient } = await import("@easy-flow/pinecone-client");

        const api = createMockApi({
          pineconeApiKey: "pcsk_test_key",
          agentId: "mell",
          indexName: "my-index",
          compactAfterDays: 14,
        });
        workflowControllerPlugin.register(api as any);

        const factory = api._contextEngineFactories.get("workflow")!;
        const engine = await factory();

        expect(PineconeClient).toHaveBeenCalledWith({
          apiKey: "pcsk_test_key",
          indexName: "my-index",
        });
        expect(api.logger.info).toHaveBeenCalledWith(
          expect.stringContaining("Pinecone delegate enabled"),
        );
        expect(engine).toBeDefined();
      });

      it("falls back to PINECONE_API_KEY env var", async () => {
        const { PineconeClient } = await import("@easy-flow/pinecone-client");

        process.env.PINECONE_API_KEY = "pcsk_env_key";
        const api = createMockApi({});
        workflowControllerPlugin.register(api as any);

        const factory = api._contextEngineFactories.get("workflow")!;
        await factory();

        expect(PineconeClient).toHaveBeenCalledWith({
          apiKey: "pcsk_env_key",
          indexName: "easy-flow-memory",
        });
      });

      it("uses default values for optional config fields", async () => {
        const { PineconeClient } = await import("@easy-flow/pinecone-client");

        const api = createMockApi({ pineconeApiKey: "pcsk_key" });
        workflowControllerPlugin.register(api as any);

        const factory = api._contextEngineFactories.get("workflow")!;
        await factory();

        expect(PineconeClient).toHaveBeenCalledWith({
          apiKey: "pcsk_key",
          indexName: "easy-flow-memory",
        });
        expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("agentId: default"));
      });
    });

    describe("Noop delegate fallback path (no Pinecone)", () => {
      it("uses noop delegate and logs warning when no Pinecone config", async () => {
        delete process.env.PINECONE_API_KEY;
        const api = createMockApi({});
        workflowControllerPlugin.register(api as any);

        const factory = api._contextEngineFactories.get("workflow")!;
        const engine = await factory();

        expect(api.logger.warn).toHaveBeenCalledWith(
          expect.stringContaining("PINECONE_API_KEY not set"),
        );
        expect(engine).toBeDefined();
      });
    });
  });
});
