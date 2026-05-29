/**
 * fallback 経路の単体テスト
 *
 * - cache miss → primary 成功 で cache_status='miss'
 * - primary 失敗 → chunk 分割成功 で 'fallback_chunk'
 * - chunk 失敗 → fallbackModel 成功 で 'fallback_model'
 * - 全段失敗 で 'failure'
 * - **Sonnet 全文 fallback が一度も呼ばれない（assertNotCalled）**
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { runWithFallback, splitIntoChunks } from "./fallback.js";
import { GeminiAuthMissingError, GeminiCallError, type GeminiClient } from "./gemini-client.js";

const FORBIDDEN_TOKENS = ["sonnet", "claude", "anthropic"];

function createMockClient(
  callImpl: (model: string, attempt: number) => Promise<unknown> | unknown,
) {
  const calls: Array<{ model: string; attempt: number }> = [];
  let attempt = 0;
  // GeminiClient を継承せず、構造的に互換な mock オブジェクトを作る
  const client = {
    generateContent: vi.fn(async (_prompt: string, modelOverride?: string) => {
      const model = modelOverride ?? "gemini-2.5-flash";
      // **必須：Sonnet 全文 fallback が呼ばれていないことを実時間で検証**
      for (const tok of FORBIDDEN_TOKENS) {
        if (model.toLowerCase().includes(tok)) {
          throw new Error(`forbidden model invoked: ${model}`);
        }
      }
      attempt++;
      calls.push({ model, attempt });
      const result = await callImpl(model, attempt);
      return result;
    }),
    resolveApiKey: vi.fn(async () => "dummy"),
  } as unknown as GeminiClient;
  return { client, calls };
}

beforeEach(() => {
  // env を temp で設定
  process.env.GEMINI_API_KEY = "ENV_KEY";
});

describe("runWithFallback", () => {
  const transcript = "短い transcript 内容";
  const query = "テスト query";
  const options = {
    primaryModel: "gemini-2.5-flash",
    fallbackModel: "gemini-1.5-flash",
  };

  it("primary 成功で cache_status='miss'", async () => {
    const { client, calls } = createMockClient(async () => ({
      rawJson: '{"answer":"ok"}',
      costUsd: 0.001,
      model: "gemini-2.5-flash",
    }));
    const res = await runWithFallback(client, transcript, query, options);
    expect(res.cacheStatus).toBe("miss");
    expect(res.model).toBe("gemini-2.5-flash");
    expect(calls).toHaveLength(1);
  });

  it("primary 失敗 + chunk 分割成功で 'fallback_chunk'", async () => {
    // 14000 文字 → chunk size 12000 で 2 chunk に分割される
    const long = "A".repeat(14000);
    const { client } = createMockClient(async (_m, attempt) => {
      // 1 回目（primary 全文）は失敗、2-3 回目（chunk 分割）は成功
      if (attempt === 1) {
        throw new GeminiCallError("429", "rate limit");
      }
      return { rawJson: '{"answer":"chunk ok"}', costUsd: 0.001, model: "gemini-2.5-flash" };
    });
    const res = await runWithFallback(client, long, query, options);
    expect(res.cacheStatus).toBe("fallback_chunk");
    expect(res.warnings).toContain("primary_model_failed:429");
  });

  it("primary 全段失敗 + fallbackModel 成功で 'fallback_model'", async () => {
    // 短い transcript（chunk 分割しても効果なし）+ primary 失敗 → fallback model 成功
    const { client } = createMockClient(async (model, _attempt) => {
      if (model === "gemini-2.5-flash") {
        throw new GeminiCallError("500", "server");
      }
      return { rawJson: '{"answer":"fallback ok"}', costUsd: 0.001, model };
    });
    const res = await runWithFallback(client, transcript, query, options);
    expect(res.cacheStatus).toBe("fallback_model");
    expect(res.model).toBe("gemini-1.5-flash");
    expect(res.warnings).toContain("fallback_model_used:gemini-1.5-flash");
  });

  it("全段失敗で 'failure'", async () => {
    const { client } = createMockClient(async () => {
      throw new GeminiCallError("500", "all down");
    });
    const res = await runWithFallback(client, transcript, query, options);
    expect(res.cacheStatus).toBe("failure");
    expect(res.lastFailureKind).toBe("500");
  });

  it("API key 未設定なら auth_missing failure として fallback/chunk retry しない", async () => {
    const { client, calls } = createMockClient(async () => {
      throw new GeminiAuthMissingError();
    });
    const res = await runWithFallback(client, "A".repeat(14000), query, options);
    expect(res.cacheStatus).toBe("failure");
    expect(res.lastFailureKind).toBe("auth_missing");
    expect(res.warnings).toContain("primary_model_failed:auth_missing");
    expect(calls).toHaveLength(1);
  });

  it("**assertNotCalled：Sonnet 全文 fallback が一度も呼ばれない**", async () => {
    // primary も fallback も全失敗にして、すべての fallback 経路を回らせる
    const { client, calls } = createMockClient(async () => {
      throw new GeminiCallError("timeout", "down");
    });
    const long = "B".repeat(14000);
    await runWithFallback(client, long, query, options);
    // 1 回も "sonnet" / "claude" / "anthropic" を含む model 呼び出しがされていない
    const forbidden = calls.filter((c) =>
      FORBIDDEN_TOKENS.some((t) => c.model.toLowerCase().includes(t)),
    );
    expect(forbidden).toHaveLength(0);
    // 呼ばれた model は gemini- 系のみ
    expect(calls.every((c) => c.model.toLowerCase().startsWith("gemini-"))).toBe(true);
  });

  it("primaryModel に forbidden token を指定すると runWithFallback が throw", async () => {
    const { client } = createMockClient(async () => ({
      rawJson: "{}",
      costUsd: 0,
      model: "x",
    }));
    await expect(
      runWithFallback(client, transcript, query, {
        primaryModel: "claude-sonnet-3.5",
        fallbackModel: "gemini-1.5-flash",
      }),
    ).rejects.toThrow(/forbidden model/);
  });

  it("primaryModel に非 Gemini model を指定すると runWithFallback が throw", async () => {
    const { client } = createMockClient(async () => ({
      rawJson: "{}",
      costUsd: 0,
      model: "x",
    }));
    await expect(
      runWithFallback(client, transcript, query, {
        primaryModel: "gpt-4.1",
        fallbackModel: "gemini-1.5-flash",
      }),
    ).rejects.toThrow(/unsupported Gemini model/);
  });

  it("fallbackModel に forbidden token を指定すると runWithFallback が throw", async () => {
    const { client } = createMockClient(async () => ({
      rawJson: "{}",
      costUsd: 0,
      model: "x",
    }));
    await expect(
      runWithFallback(client, transcript, query, {
        primaryModel: "gemini-2.5-flash",
        fallbackModel: "claude-haiku",
      }),
    ).rejects.toThrow(/forbidden model/);
  });

  it("fallbackModel に非 Gemini model を指定すると runWithFallback が throw", async () => {
    const { client } = createMockClient(async () => ({
      rawJson: "{}",
      costUsd: 0,
      model: "x",
    }));
    await expect(
      runWithFallback(client, transcript, query, {
        primaryModel: "gemini-2.5-flash",
        fallbackModel: "gpt-4.1",
      }),
    ).rejects.toThrow(/unsupported Gemini model/);
  });

  it("chunk fallback の citation byte_range は UTF-8 byte offset で補正される", async () => {
    const multibyte = `${"あ".repeat(4)}B`;
    const { client } = createMockClient(async (_model, attempt) => {
      if (attempt === 1) {
        throw new GeminiCallError("429", "rate limit");
      }
      if (attempt === 2) {
        return {
          rawJson: JSON.stringify({
            answer: "chunk 1",
            citations: [{ chunk_id: "c-1", byte_range: [0, 3], excerpt: "あ" }],
          }),
          costUsd: 0.001,
          model: "gemini-2.5-flash",
        };
      }
      return {
        rawJson: JSON.stringify({
          answer: "chunk 2",
          citations: [{ chunk_id: "c-2", byte_range: [0, 1], excerpt: "B" }],
        }),
        costUsd: 0.001,
        model: "gemini-2.5-flash",
      };
    });

    const res = await runWithFallback(client, multibyte, query, {
      ...options,
      chunkMaxChars: 4,
    });
    const parsed = JSON.parse(res.rawJson) as {
      citations: Array<{ chunk_id: string; byte_range: [number, number] }>;
    };

    expect(res.cacheStatus).toBe("fallback_chunk");
    expect(parsed.citations.find((c) => c.chunk_id === "c-2")?.byte_range).toEqual([12, 13]);
  });
});

describe("splitIntoChunks", () => {
  it("chunk_max_chars 以下なら 1 chunk のまま", () => {
    expect(splitIntoChunks("hello", 100)).toEqual(["hello"]);
  });

  it("chunk_max_chars 超で複数 chunk に分割", () => {
    const text = "abc\ndef\nghi\njkl\nmno";
    const chunks = splitIntoChunks(text, 8);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  it("改行で寄せた境界", () => {
    const text = "0123456789\nabcdef";
    const chunks = splitIntoChunks(text, 12);
    // 改行で寄せた結果、1 chunk 目は改行位置までで切れ、2 chunk 目は改行始まりになる
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]).toBe("0123456789");
    expect(chunks[1].startsWith("\n")).toBe(true);
    // 連結すると元の text に戻る
    expect(chunks.join("")).toBe(text);
  });

  it("chunk_max_chars <= 0 は全体を 1 chunk", () => {
    expect(splitIntoChunks("xyz", 0)).toEqual(["xyz"]);
  });
});
