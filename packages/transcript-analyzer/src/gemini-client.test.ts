/**
 * GeminiClient の単体テスト
 *
 * - auth 解決順序：provider secret → env → throw
 * - forbidden model token（sonnet/claude/anthropic）は constructor / generateContent で throw
 * - error classification（429 / 500 / timeout / auth_missing）
 * - timeout が指定 ms で発火
 *
 * Gemini SDK は vitest mock で差し替え、実 API 呼び出しは発生させない。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyGeminiError,
  GeminiAuthMissingError,
  GeminiCallError,
  GeminiClient,
} from "./gemini-client.js";

// ----------------------------------------------------------------------------
// Gemini SDK の mock：generateContent のみ差し替える
// ----------------------------------------------------------------------------

const mockGenerateContent = vi.fn();

vi.mock("@google/generative-ai", () => {
  return {
    GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
      getGenerativeModel: () => ({
        generateContent: mockGenerateContent,
      }),
    })),
  };
});

beforeEach(() => {
  mockGenerateContent.mockReset();
});

const ENV_BACKUP = process.env.GEMINI_API_KEY;
afterEach(() => {
  if (ENV_BACKUP === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = ENV_BACKUP;
});

// ----------------------------------------------------------------------------
// auth 解決
// ----------------------------------------------------------------------------

describe("GeminiClient.resolveApiKey", () => {
  it("provider secret 'google' が最優先", async () => {
    process.env.GEMINI_API_KEY = "ENV_KEY";
    const c = new GeminiClient({
      model: "gemini-2.5-flash",
      timeoutSec: 5,
      authContext: {
        resolveApiKeyForProvider: async (p) => (p === "google" ? "PROVIDER_KEY" : undefined),
      },
    });
    expect(await c.resolveApiKey()).toBe("PROVIDER_KEY");
  });

  it("provider secret 未設定なら env fallback", async () => {
    process.env.GEMINI_API_KEY = "ENV_KEY";
    const c = new GeminiClient({
      model: "gemini-2.5-flash",
      timeoutSec: 5,
      authContext: { resolveApiKeyForProvider: async () => undefined },
    });
    expect(await c.resolveApiKey()).toBe("ENV_KEY");
  });

  it("両方未設定なら GeminiAuthMissingError", async () => {
    delete process.env.GEMINI_API_KEY;
    const c = new GeminiClient({
      model: "gemini-2.5-flash",
      timeoutSec: 5,
    });
    await expect(c.resolveApiKey()).rejects.toBeInstanceOf(GeminiAuthMissingError);
  });

  it("provider secret resolution が throw しても env fallback に進む", async () => {
    process.env.GEMINI_API_KEY = "ENV_KEY";
    const c = new GeminiClient({
      model: "gemini-2.5-flash",
      timeoutSec: 5,
      authContext: {
        resolveApiKeyForProvider: () => {
          throw new Error("provider down");
        },
      },
    });
    expect(await c.resolveApiKey()).toBe("ENV_KEY");
  });
});

// ----------------------------------------------------------------------------
// forbidden model token
// ----------------------------------------------------------------------------

describe("forbidden model guard", () => {
  it("constructor で sonnet を含む model は throw", () => {
    expect(() => new GeminiClient({ model: "claude-3-sonnet", timeoutSec: 5 })).toThrow(
      /forbidden model/,
    );
  });

  it("generateContent で modelOverride が sonnet/claude を含む場合は throw", async () => {
    process.env.GEMINI_API_KEY = "ENV_KEY";
    const c = new GeminiClient({ model: "gemini-2.5-flash", timeoutSec: 5 });
    await expect(c.generateContent("prompt", "claude-3-sonnet-20240229")).rejects.toThrow(
      /forbidden model/,
    );
  });

  it("'anthropic' を含むモデル名も拒否", async () => {
    process.env.GEMINI_API_KEY = "ENV_KEY";
    const c = new GeminiClient({ model: "gemini-2.5-flash", timeoutSec: 5 });
    await expect(c.generateContent("prompt", "anthropic-haiku")).rejects.toThrow(/forbidden model/);
  });
});

// ----------------------------------------------------------------------------
// generateContent 経路
// ----------------------------------------------------------------------------

describe("GeminiClient.generateContent", () => {
  it("成功時に rawJson + cost を返す", async () => {
    process.env.GEMINI_API_KEY = "ENV_KEY";
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => '{"answer":"ok"}',
        usageMetadata: { totalTokenCount: 1000 },
      },
    });
    const c = new GeminiClient({ model: "gemini-2.5-flash", timeoutSec: 5 });
    const res = await c.generateContent("prompt");
    expect(res.rawJson).toBe('{"answer":"ok"}');
    expect(res.model).toBe("gemini-2.5-flash");
    expect(res.costUsd).toBeGreaterThan(0);
  });

  it("API key 未設定で auth_missing error", async () => {
    delete process.env.GEMINI_API_KEY;
    const c = new GeminiClient({ model: "gemini-2.5-flash", timeoutSec: 5 });
    await expect(c.generateContent("prompt")).rejects.toBeInstanceOf(GeminiAuthMissingError);
  });

  it("429 error を kind=429 として変換", async () => {
    process.env.GEMINI_API_KEY = "ENV_KEY";
    mockGenerateContent.mockRejectedValueOnce(
      Object.assign(new Error("429 Too Many Requests"), { status: 429 }),
    );
    const c = new GeminiClient({ model: "gemini-2.5-flash", timeoutSec: 5 });
    try {
      await c.generateContent("prompt");
      expect.fail("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GeminiCallError);
      expect((err as GeminiCallError).kind).toBe("429");
    }
  });

  it("500 error を kind=500 として変換", async () => {
    process.env.GEMINI_API_KEY = "ENV_KEY";
    mockGenerateContent.mockRejectedValueOnce(new Error("500 Internal Server Error"));
    const c = new GeminiClient({ model: "gemini-2.5-flash", timeoutSec: 5 });
    try {
      await c.generateContent("prompt");
      expect.fail("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GeminiCallError);
      expect((err as GeminiCallError).kind).toBe("500");
    }
  });

  it("timeout を kind=timeout として変換", async () => {
    process.env.GEMINI_API_KEY = "ENV_KEY";
    // 100ms 後に解決される promise を返すが、client の timeoutSec=0.05 で先に timeout 発火
    mockGenerateContent.mockImplementationOnce(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ response: { text: () => "{}" } }), 200),
        ),
    );
    const c = new GeminiClient({ model: "gemini-2.5-flash", timeoutSec: 0.05 });
    try {
      await c.generateContent("prompt");
      expect.fail("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GeminiCallError);
      expect((err as GeminiCallError).kind).toBe("timeout");
    }
  });
});

describe("classifyGeminiError", () => {
  it("429 message", () => {
    expect(classifyGeminiError(new Error("429 Too Many Requests"))).toBe("429");
    expect(classifyGeminiError(new Error("rate limit exceeded"))).toBe("429");
    expect(classifyGeminiError(new Error("quota exhausted"))).toBe("429");
  });

  it("timeout message", () => {
    expect(classifyGeminiError(new Error("Request timed out"))).toBe("timeout");
    expect(classifyGeminiError(new Error("aborted"))).toBe("timeout");
  });

  it("500 fallback", () => {
    expect(classifyGeminiError(new Error("unknown server error"))).toBe("500");
  });
});
