import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { QueryResult } from "@easy-flow/pinecone-client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { PineconeContextEngine } from "./pinecone-context-engine.js";
import type { IPineconeClient } from "./types.js";

function createMockClient(
  overrides?: Partial<IPineconeClient>,
): IPineconeClient & { [K in keyof IPineconeClient]: Mock } {
  return {
    upsert: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteBySource: vi.fn().mockResolvedValue(undefined),
    deleteNamespace: vi.fn().mockResolvedValue(undefined),
    ensureIndex: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as IPineconeClient & { [K in keyof IPineconeClient]: Mock };
}

function makeQueryResult(
  text: string,
  score: number,
  sourceType: "agents_rule" | "memory_file" | "session_turn" | "workflow_state" = "session_turn",
  createdAt: number = Date.now(),
): QueryResult {
  return {
    chunk: {
      id: `chunk-${Math.random().toString(36).slice(2, 8)}`,
      text,
      metadata: {
        agentId: "test-agent",
        sourceFile: "test.md",
        sourceType,
        chunkIndex: 0,
        createdAt,
      },
    },
    score,
  };
}

const AGENTS_CORE_CONTENT = "# AGENTS-CORE\n\nCore rules for the agent.";

describe("PineconeContextEngine - RAG mode", () => {
  let tmpDir: string;
  let agentsCorePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-test-"));
    agentsCorePath = path.join(tmpDir, "AGENTS-CORE.md");
    fs.writeFileSync(agentsCorePath, AGENTS_CORE_CONTENT);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("RAG_ENABLED=false (デフォルト)", () => {
    it("従来の動作が変わらない — assembleClassic が使われる", async () => {
      const client = createMockClient();
      const results: QueryResult[] = [makeQueryResult("Previous conversation about testing", 0.85)];
      client.query.mockResolvedValue(results);

      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
        // ragEnabled は未設定（デフォルト false）
      });

      const result = await engine.assemble({
        sessionId: "s1",
        messages: [{ role: "user", content: "How do I write tests?" }],
      });

      expect(result.systemPromptAddition).toContain("Relevant Memory");
      expect(result.systemPromptAddition).not.toContain("AGENTS-CORE");
      expect(result.systemPromptAddition).not.toContain("Relevant Knowledge");
    });

    it("ragEnabled=false を明示しても従来の動作", async () => {
      const client = createMockClient();
      client.query.mockResolvedValue([]);

      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
        ragEnabled: false,
        agentsCorePath,
      });

      const result = await engine.assemble({
        sessionId: "s1",
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(result.systemPromptAddition).toBeUndefined();
      expect(result.estimatedTokens).toBe(0);
    });
  });

  describe("RAG_ENABLED=true", () => {
    it("AGENTS-CORE.md + 動的チャンクが systemPromptAddition に含まれる", async () => {
      const client = createMockClient();
      const results: QueryResult[] = [
        makeQueryResult("Dynamic rule from Pinecone", 0.9, "agents_rule"),
        makeQueryResult("Memory about user preferences", 0.85, "memory_file"),
      ];
      client.query.mockResolvedValue(results);

      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
        ragEnabled: true,
        agentsCorePath,
      });

      const result = await engine.assemble({
        sessionId: "s1",
        messages: [{ role: "user", content: "What are my preferences?" }],
      });

      expect(result.systemPromptAddition).toContain("AGENTS-CORE");
      expect(result.systemPromptAddition).toContain("Core rules for the agent");
      expect(result.systemPromptAddition).toContain("Relevant Knowledge");
      expect(result.systemPromptAddition).toContain("Dynamic rule from Pinecone");
      expect(result.systemPromptAddition).toContain("Memory about user preferences");
      expect(result.estimatedTokens).toBeGreaterThan(0);
    });

    it("ragTopK と ragMinScore がクエリに使用される", async () => {
      const client = createMockClient();
      client.query.mockResolvedValue([]);

      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
        ragEnabled: true,
        agentsCorePath,
        ragTopK: 5,
        ragMinScore: 0.8,
      });

      await engine.assemble({
        sessionId: "s1",
        messages: [{ role: "user", content: "Test query" }],
      });

      const queryParams = client.query.mock.calls[0][0];
      expect(queryParams.topK).toBe(5);
      expect(queryParams.minScore).toBe(0.8);
    });

    it("re-ranking が適用される — agents_rule が優先される", async () => {
      const client = createMockClient();
      const now = Date.now();
      const results: QueryResult[] = [
        makeQueryResult("Session turn text", 0.9, "session_turn", now),
        makeQueryResult("Agents rule text", 0.88, "agents_rule", now),
      ];
      client.query.mockResolvedValue(results);

      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
        ragEnabled: true,
        agentsCorePath,
      });

      const result = await engine.assemble({
        sessionId: "s1",
        messages: [{ role: "user", content: "Apply rules" }],
      });

      const addition = result.systemPromptAddition ?? "";
      // agents_rule が re-ranking で上位に来る（sourceType weight が高い）
      const agentsRuleIndex = addition.indexOf("Agents rule text");
      const sessionTurnIndex = addition.indexOf("Session turn text");
      expect(agentsRuleIndex).toBeLessThan(sessionTurnIndex);
    });
  });

  describe("トークン予算", () => {
    it("トークン予算超過時に低スコアチャンクが除外される", async () => {
      const client = createMockClient();
      const longText = "A".repeat(8000); // ~2000 ASCII tokens
      const overflowText = "B".repeat(400); // ~100 tokens → 残り予算を超過
      const results: QueryResult[] = [
        makeQueryResult(longText, 0.95, "agents_rule"),
        makeQueryResult(overflowText, 0.8, "memory_file"),
      ];
      client.query.mockResolvedValue(results);

      // ragTokenBudget は総予算（core + dynamic）
      // AGENTS-CORE.md ~10 tokens → 動的予算 ~2040 → longText (2000) は入る → overflowText (100) は超過
      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
        ragEnabled: true,
        agentsCorePath,
        ragTokenBudget: 2050,
      });

      const result = await engine.assemble({
        sessionId: "s1",
        messages: [{ role: "user", content: "Test budget" }],
      });

      expect(result.systemPromptAddition).toContain("AGENTS-CORE");
      expect(result.systemPromptAddition).toContain(longText);
      expect(result.systemPromptAddition).not.toContain(overflowText);
    });

    it("ragTokenBudget パラメータで予算を制御可能", async () => {
      const client = createMockClient();
      const results: QueryResult[] = [makeQueryResult("Short chunk", 0.9, "agents_rule")];
      client.query.mockResolvedValue(results);

      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
        ragEnabled: true,
        agentsCorePath,
        ragTokenBudget: 500,
      });

      const consoleSpy = vi.spyOn(console, "info").mockImplementation(() => {});

      await engine.assemble({
        sessionId: "s1",
        messages: [{ role: "user", content: "Budget test" }],
      });

      // ログに budget=500 が出力される
      const budgetLog = consoleSpy.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("budget=500"),
      );
      expect(budgetLog).toBeDefined();
    });
  });

  describe("フォールバック", () => {
    it("Pinecone 接続不可時 — AGENTS-CORE.md のみで動作する（warn ログ出力）", async () => {
      const client = createMockClient();
      client.query.mockRejectedValue(new Error("connection refused"));

      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
        ragEnabled: true,
        agentsCorePath,
      });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await engine.assemble({
        sessionId: "s1",
        messages: [{ role: "user", content: "Pinecone is down" }],
      });

      expect(result.systemPromptAddition).toContain("AGENTS-CORE");
      expect(result.systemPromptAddition).toContain("Core rules for the agent");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[pinecone-context-engine] Pinecone query failed in RAG mode:"),
        expect.any(Error),
      );
    });

    it("AGENTS-CORE.md 不在 — 動的チャンクのみで動作する（warn ログ出力）", async () => {
      const client = createMockClient();
      const results: QueryResult[] = [makeQueryResult("Dynamic chunk only", 0.9, "agents_rule")];
      client.query.mockResolvedValue(results);

      const nonExistentPath = path.join(tmpDir, "NON_EXISTENT.md");

      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
        ragEnabled: true,
        agentsCorePath: nonExistentPath,
      });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await engine.assemble({
        sessionId: "s1",
        messages: [{ role: "user", content: "No core file" }],
      });

      expect(result.systemPromptAddition).toContain("Dynamic chunk only");
      expect(result.systemPromptAddition).not.toContain("AGENTS-CORE");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[pinecone-context-engine] AGENTS-CORE.md not found:"),
      );
    });

    it("検索結果 0 件 — AGENTS-CORE.md のみで応答する", async () => {
      const client = createMockClient();
      client.query.mockResolvedValue([]);

      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
        ragEnabled: true,
        agentsCorePath,
      });

      vi.spyOn(console, "info").mockImplementation(() => {});

      const result = await engine.assemble({
        sessionId: "s1",
        messages: [{ role: "user", content: "No results query" }],
      });

      expect(result.systemPromptAddition).toContain("AGENTS-CORE");
      expect(result.systemPromptAddition).toContain("Core rules for the agent");
      expect(result.systemPromptAddition).not.toContain("Relevant Knowledge");
    });

    it("Pinecone 接続不可 + AGENTS-CORE.md 不在 — fallback adapter が使われる", async () => {
      const client = createMockClient();
      client.query.mockRejectedValue(new Error("connection refused"));

      const fallbackAdapter = {
        info: { id: "mock-fallback", name: "Mock Fallback", version: "0.0.1" },
        ingest: vi.fn().mockResolvedValue({ ingested: false }),
        assemble: vi.fn().mockResolvedValue({
          messages: [],
          estimatedTokens: 0,
          systemPromptAddition: "fallback content",
        }),
        compact: vi.fn().mockResolvedValue({ ok: true, compacted: false }),
      };

      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
        ragEnabled: true,
        agentsCorePath: path.join(tmpDir, "NON_EXISTENT.md"),
        fallbackAdapter,
      });

      vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await engine.assemble({
        sessionId: "s1",
        messages: [{ role: "user", content: "Everything fails" }],
      });

      expect(result.systemPromptAddition).toBe("fallback content");
    });
  });

  describe("構造化ログ", () => {
    it("assemble 実行時に mode, results, latency, tokens を含むログが出力される", async () => {
      const client = createMockClient();
      const results: QueryResult[] = [
        makeQueryResult("Rule chunk", 0.9, "agents_rule"),
        makeQueryResult("Memory chunk", 0.85, "memory_file"),
      ];
      client.query.mockResolvedValue(results);

      const engine = new PineconeContextEngine({
        pineconeClient: client,
        agentId: "test-agent",
        ragEnabled: true,
        agentsCorePath,
        ragTopK: 10,
      });

      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

      await engine.assemble({
        sessionId: "s1",
        messages: [{ role: "user", content: "Log test" }],
      });

      const logMessages = infoSpy.mock.calls.map((c) => c[0] as string);

      // mode=rag ログ
      const modeLog = logMessages.find((m) => m.includes("mode=rag"));
      expect(modeLog).toBeDefined();
      expect(modeLog).toContain("ns=agent:test-agent");
      expect(modeLog).toContain("topK=10");
      expect(modeLog).toContain("results=2");
      expect(modeLog).toMatch(/latency=\d+ms/);

      // rerank ログ
      const rerankLog = logMessages.find((m) => m.includes("rerank:"));
      expect(rerankLog).toBeDefined();
      expect(rerankLog).toContain("agents_rule=1");
      expect(rerankLog).toContain("memory_file=1");

      // merged ログ
      const mergedLog = logMessages.find((m) => m.includes("merged:"));
      expect(mergedLog).toBeDefined();
      expect(mergedLog).toMatch(/core_tokens=\d+/);
      expect(mergedLog).toMatch(/dynamic_tokens=\d+/);
      expect(mergedLog).toMatch(/total=\d+/);
      expect(mergedLog).toMatch(/budget=\d+/);
    });
  });
});
