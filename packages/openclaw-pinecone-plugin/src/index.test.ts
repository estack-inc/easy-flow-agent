import { describe, it, expect, vi } from "vitest";
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
      expect.stringContaining("PINECONE_API_KEY not set")
    );
    expect(api.registerContextEngine).not.toHaveBeenCalled();

    process.env.PINECONE_API_KEY = originalEnv;
  });

  it("registers context engine with API key from pluginConfig", () => {
    const api = createMockApi({ apiKey: "test-key", agentId: "mell" });
    register(api as any);

    expect(api.registerContextEngine).toHaveBeenCalledWith(
      "pinecone-memory",
      expect.any(Function)
    );
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("agentId: mell")
    );
  });

  it("registers context engine with API key from env var", () => {
    const originalEnv = process.env.PINECONE_API_KEY;
    process.env.PINECONE_API_KEY = "env-key";

    const api = createMockApi({});
    register(api as any);

    expect(api.registerContextEngine).toHaveBeenCalledWith(
      "pinecone-memory",
      expect.any(Function)
    );

    process.env.PINECONE_API_KEY = originalEnv;
  });

  it("uses default agentId when not specified", () => {
    const api = createMockApi({ apiKey: "test-key" });
    register(api as any);

    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("agentId: default")
    );
  });

  it("uses custom indexName and compactAfterDays", () => {
    const api = createMockApi({
      apiKey: "test-key",
      agentId: "mell",
      indexName: "custom-index",
      compactAfterDays: 14,
    });
    register(api as any);

    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("index: custom-index")
    );
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("compactAfterDays: 14")
    );
  });
});
