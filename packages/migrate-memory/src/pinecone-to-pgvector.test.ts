import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type MigrateOptions,
  migrateConversationMemory,
  pineconeFetch,
  pineconeList,
} from "./pinecone-to-pgvector.js";

// --- fetch mock ---
const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchMock);

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

// --- mock pgvector client ---
function createMockClient() {
  return {
    upsert: vi.fn(async () => {}),
    query: vi.fn(async () => []),
    delete: vi.fn(async () => {}),
    deleteBySource: vi.fn(async () => {}),
    deleteNamespace: vi.fn(async () => {}),
    ensureIndex: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pineconeList", () => {
  it("should list vector IDs with pagination", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        vectors: [{ id: "v1" }, { id: "v2" }],
        pagination: { next: "token123" },
      }),
    );

    const result = await pineconeList("host.pinecone.io", "api-key", "agent:mell");

    expect(result.ids).toEqual(["v1", "v2"]);
    expect(result.nextToken).toBe("token123");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("host.pinecone.io/vectors/list"),
      expect.objectContaining({ headers: { "Api-Key": "api-key" } }),
    );
  });

  it("should return empty ids when no vectors", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ vectors: [] }));

    const result = await pineconeList("host.pinecone.io", "api-key", "agent:test");

    expect(result.ids).toEqual([]);
    expect(result.nextToken).toBeUndefined();
  });

  it("should pass paginationToken when provided", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ vectors: [{ id: "v3" }] }));

    await pineconeList("host.pinecone.io", "api-key", "agent:test", "page-token");

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("paginationToken=page-token");
  });

  it("should throw on non-OK response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401));

    await expect(pineconeList("host.pinecone.io", "api-key", "agent:test")).rejects.toThrow(
      "Pinecone list failed: 401",
    );
  });
});

describe("pineconeFetch", () => {
  it("should fetch vectors with metadata", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        vectors: {
          "mell:turn:1:0": {
            metadata: {
              agentId: "mell",
              sourceType: "session_turn",
              sourceFile: "session:abc",
              chunkIndex: 0,
              createdAt: 1000,
              text: "hello",
              role: "user",
            },
          },
        },
      }),
    );

    const result = await pineconeFetch("host.pinecone.io", "api-key", "agent:mell", [
      "mell:turn:1:0",
    ]);

    expect(result.size).toBe(1);
    expect(result.get("mell:turn:1:0")?.text).toBe("hello");
    expect(result.get("mell:turn:1:0")?.sourceType).toBe("session_turn");
  });

  it("should throw on non-OK response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "not found" }, 404));

    await expect(
      pineconeFetch("host.pinecone.io", "api-key", "agent:test", ["id1"]),
    ).rejects.toThrow("Pinecone fetch failed: 404");
  });
});

describe("migrateConversationMemory", () => {
  function createOptions(overrides: Partial<MigrateOptions> = {}): MigrateOptions {
    return {
      pineconeApiKey: "test-key",
      pineconeHost: "host.pinecone.io",
      pgvectorClient: createMockClient(),
      namespaces: ["agent:test"],
      dryRun: false,
      skipExisting: true,
      sourceTypes: ["session_turn", "conversation"],
      ...overrides,
    };
  }

  it("should migrate conversation memory and skip non-conversation vectors", async () => {
    // List returns 3 IDs
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ vectors: [{ id: "v1" }, { id: "v2" }, { id: "v3" }] }),
    );
    // Fetch returns metadata: 2 conversation, 1 agents_rule
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        vectors: {
          v1: {
            metadata: {
              agentId: "test",
              sourceType: "session_turn",
              sourceFile: "session:abc",
              chunkIndex: 0,
              createdAt: 1000,
              text: "user message",
            },
          },
          v2: {
            metadata: {
              agentId: "test",
              sourceType: "agents_rule",
              sourceFile: "AGENTS.md",
              chunkIndex: 0,
              createdAt: 2000,
              text: "rule text",
            },
          },
          v3: {
            metadata: {
              agentId: "test",
              sourceType: "conversation",
              sourceFile: "session:def",
              chunkIndex: 0,
              createdAt: 3000,
              text: "assistant reply",
            },
          },
        },
      }),
    );

    const opts = createOptions();
    const results = await migrateConversationMemory(opts);

    expect(results).toHaveLength(1);
    expect(results[0].totalPinecone).toBe(3);
    expect(results[0].migrated).toBe(2);
    expect(results[0].skippedExisting).toBe(1); // agents_rule skipped
    expect(opts.pgvectorClient.upsert).toHaveBeenCalledTimes(1);

    const upsertedChunks = vi.mocked(opts.pgvectorClient.upsert).mock.calls[0][0];
    expect(upsertedChunks).toHaveLength(2);
    expect(upsertedChunks[0].metadata.sourceType).toBe("session_turn");
    // "conversation" is normalized to "session_turn" with category "conversation"
    expect(upsertedChunks[1].metadata.sourceType).toBe("session_turn");
    expect(upsertedChunks[1].metadata.category).toBe("conversation");
  });

  it("should not upsert in dry-run mode", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ vectors: [{ id: "v1" }] }));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        vectors: {
          v1: {
            metadata: {
              agentId: "test",
              sourceType: "session_turn",
              sourceFile: "session:abc",
              chunkIndex: 0,
              createdAt: 1000,
              text: "hello",
            },
          },
        },
      }),
    );

    const opts = createOptions({ dryRun: true });
    const results = await migrateConversationMemory(opts);

    expect(results[0].migrated).toBe(1);
    expect(opts.pgvectorClient.upsert).not.toHaveBeenCalled();
  });

  it("should handle empty namespace", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ vectors: [] }));

    const results = await migrateConversationMemory(createOptions());

    expect(results[0].totalPinecone).toBe(0);
    expect(results[0].migrated).toBe(0);
  });

  it("should skip vectors without text", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ vectors: [{ id: "v1" }, { id: "v2" }] }));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        vectors: {
          v1: {
            metadata: {
              agentId: "test",
              sourceType: "session_turn",
              sourceFile: "session:abc",
              chunkIndex: 0,
              createdAt: 1000,
              text: "",
            },
          },
          v2: {
            metadata: {
              agentId: "test",
              sourceType: "session_turn",
              sourceFile: "session:def",
              chunkIndex: 0,
              createdAt: 2000,
              text: "valid text",
            },
          },
        },
      }),
    );

    const results = await migrateConversationMemory(createOptions());

    expect(results[0].skippedNoText).toBe(1);
    expect(results[0].migrated).toBe(1);
  });

  it("should handle upsert errors gracefully", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ vectors: [{ id: "v1" }] }));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        vectors: {
          v1: {
            metadata: {
              agentId: "test",
              sourceType: "session_turn",
              sourceFile: "session:abc",
              chunkIndex: 0,
              createdAt: 1000,
              text: "hello",
            },
          },
        },
      }),
    );

    const client = createMockClient();
    client.upsert.mockRejectedValueOnce(new Error("DB connection failed"));

    const results = await migrateConversationMemory(createOptions({ pgvectorClient: client }));

    expect(results[0].errors).toBe(1);
    expect(results[0].migrated).toBe(0);
  });

  it("should handle pagination across multiple pages", async () => {
    // Page 1: returns 2 IDs with pagination token
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        vectors: [{ id: "v1" }, { id: "v2" }],
        pagination: { next: "page2token" },
      }),
    );
    // Page 2: returns 1 ID, no more pages
    fetchMock.mockResolvedValueOnce(jsonResponse({ vectors: [{ id: "v3" }] }));
    // Fetch for all 3 IDs
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        vectors: {
          v1: {
            metadata: {
              agentId: "test",
              sourceType: "session_turn",
              sourceFile: "s:1",
              chunkIndex: 0,
              createdAt: 1000,
              text: "msg1",
            },
          },
          v2: {
            metadata: {
              agentId: "test",
              sourceType: "session_turn",
              sourceFile: "s:2",
              chunkIndex: 0,
              createdAt: 2000,
              text: "msg2",
            },
          },
          v3: {
            metadata: {
              agentId: "test",
              sourceType: "session_turn",
              sourceFile: "s:3",
              chunkIndex: 0,
              createdAt: 3000,
              text: "msg3",
            },
          },
        },
      }),
    );

    const results = await migrateConversationMemory(createOptions());

    expect(results[0].totalPinecone).toBe(3);
    expect(results[0].migrated).toBe(3);
    // Verify pagination token was passed in second list call
    const secondListUrl = fetchMock.mock.calls[1][0] as string;
    expect(secondListUrl).toContain("paginationToken=page2token");
  });

  it("should include all sourceTypes when sourceTypes is undefined", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ vectors: [{ id: "v1" }, { id: "v2" }] }));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        vectors: {
          v1: {
            metadata: {
              agentId: "test",
              sourceType: "session_turn",
              sourceFile: "session:abc",
              chunkIndex: 0,
              createdAt: 1000,
              text: "conversation text",
            },
          },
          v2: {
            metadata: {
              agentId: "test",
              sourceType: "agents_rule",
              sourceFile: "AGENTS.md",
              chunkIndex: 0,
              createdAt: 2000,
              text: "rule text",
            },
          },
        },
      }),
    );

    const results = await migrateConversationMemory(createOptions({ sourceTypes: undefined }));

    expect(results[0].migrated).toBe(2);
    expect(results[0].skippedExisting).toBe(0);
  });

  it("should migrate multiple namespaces", async () => {
    // Namespace 1: agent:a
    fetchMock.mockResolvedValueOnce(jsonResponse({ vectors: [{ id: "a1" }] }));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        vectors: {
          a1: {
            metadata: {
              agentId: "a",
              sourceType: "session_turn",
              sourceFile: "s:1",
              chunkIndex: 0,
              createdAt: 1000,
              text: "msg from a",
            },
          },
        },
      }),
    );
    // Namespace 2: agent:b
    fetchMock.mockResolvedValueOnce(jsonResponse({ vectors: [{ id: "b1" }, { id: "b2" }] }));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        vectors: {
          b1: {
            metadata: {
              agentId: "b",
              sourceType: "session_turn",
              sourceFile: "s:2",
              chunkIndex: 0,
              createdAt: 2000,
              text: "msg from b",
            },
          },
          b2: {
            metadata: {
              agentId: "b",
              sourceType: "session_turn",
              sourceFile: "s:3",
              chunkIndex: 0,
              createdAt: 3000,
              text: "msg2 from b",
            },
          },
        },
      }),
    );

    const results = await migrateConversationMemory(
      createOptions({ namespaces: ["agent:a", "agent:b"] }),
    );

    expect(results).toHaveLength(2);
    expect(results[0].namespace).toBe("agent:a");
    expect(results[0].migrated).toBe(1);
    expect(results[1].namespace).toBe("agent:b");
    expect(results[1].migrated).toBe(2);
  });
});
