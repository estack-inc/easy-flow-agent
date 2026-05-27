/**
 * token-estimator の単体テスト
 *
 * 検証点：
 * - utf8ByteLength が UTF-8 byte 数を返す
 * - estimateTokenCount が byte 数 / 4 の ceil を返す
 * - estimateMessagesTokenCount が messages 配列の合算を返す
 * - estimatePromptInputTokens が prompt + messages の合算を返す
 * - perTurnPromptInputThreshold 境界値（49,999 / 50,000 / 50,001 token）で gate の判定が正しい
 * - sessionTokenBudget 境界値（499,999 / 500,000 / 500,001 token）で breaker の判定が正しい
 */

import { describe, expect, it } from "vitest";
import {
  estimateMessagesTokenCount,
  estimatePromptInputTokens,
  estimateTokenCount,
  utf8ByteLength,
} from "./token-estimator.js";

describe("utf8ByteLength", () => {
  it("ASCII の byte 数を返す", () => {
    expect(utf8ByteLength("hello")).toBe(5);
    expect(utf8ByteLength("")).toBe(0);
  });

  it("日本語 (3 byte/char) の byte 数を返す", () => {
    expect(utf8ByteLength("日本語")).toBe(9);
  });
});

describe("estimateTokenCount", () => {
  it("空文字列は 0 token", () => {
    expect(estimateTokenCount("")).toBe(0);
  });

  it("4 byte は 1 token", () => {
    expect(estimateTokenCount("abcd")).toBe(1);
  });

  it("5 byte は 2 token（ceil）", () => {
    expect(estimateTokenCount("abcde")).toBe(2);
  });

  it("3 byte は 1 token（ceil）", () => {
    expect(estimateTokenCount("abc")).toBe(1);
  });
});

describe("estimateMessagesTokenCount", () => {
  it("undefined / null は 0", () => {
    expect(estimateMessagesTokenCount(undefined)).toBe(0);
    expect(estimateMessagesTokenCount(null)).toBe(0);
  });

  it("空配列は 0", () => {
    expect(estimateMessagesTokenCount([])).toBe(0);
  });

  it("単一 message を含めて合算", () => {
    const r = estimateMessagesTokenCount([{ role: "user", content: "hello world" }]);
    // role(4 byte = 1 token) + content(11 byte = 3 token) + tool_call_id(0) + overhead(4) = 8
    expect(r).toBe(8);
  });

  it("複数 message を合算", () => {
    const r = estimateMessagesTokenCount([
      { role: "user", content: "abcd" },
      { role: "assistant", content: "efgh" },
    ]);
    // user: 1 + 1 + 0 + 4 = 6
    // assistant: 3 + 1 + 0 + 4 = 8
    expect(r).toBe(14);
  });

  it("tool_call_id も加算", () => {
    const r = estimateMessagesTokenCount([
      { role: "tool", content: "abcd", tool_call_id: "tcid_abcd" },
    ]);
    // tool: 1 + 1 + 3 + 4 = 9
    expect(r).toBe(9);
  });

  it("不正な entry はスキップ", () => {
    const r = estimateMessagesTokenCount([
      null as any,
      undefined as any,
      { role: "user", content: "abcd" },
    ]);
    expect(r).toBe(6); // valid one only
  });
});

describe("estimatePromptInputTokens", () => {
  it("prompt + messages を合算", () => {
    const r = estimatePromptInputTokens("abcd", [{ role: "user", content: "efgh" }]);
    // prompt(4 byte = 1 token) + messages(1 + 1 + 0 + 4 = 6) = 7
    expect(r).toBe(7);
  });

  it("prompt 未定義時は messages のみ", () => {
    const r = estimatePromptInputTokens(undefined, [{ role: "user", content: "abcd" }]);
    expect(r).toBe(6);
  });

  describe("perTurnPromptInputThreshold 境界値検証", () => {
    const threshold = 50_000;

    it("threshold 未満 (49,999 token) は block しない", () => {
      // 4 byte * 49_999 - overhead 4 = 199_996 - 16 = ... 単純化のため prompt 直接
      const prompt = "x".repeat(199_996); // 49_999 tokens
      const tokens = estimatePromptInputTokens(prompt, undefined);
      expect(tokens).toBe(49_999);
      expect(tokens > threshold).toBe(false);
    });

    it("threshold ちょうど (50,000 token) は block しない", () => {
      const prompt = "x".repeat(200_000); // 50_000 tokens
      const tokens = estimatePromptInputTokens(prompt, undefined);
      expect(tokens).toBe(50_000);
      expect(tokens > threshold).toBe(false);
    });

    it("threshold 超過 (50,001 token) は block する", () => {
      const prompt = "x".repeat(200_004); // 50_001 tokens
      const tokens = estimatePromptInputTokens(prompt, undefined);
      expect(tokens).toBe(50_001);
      expect(tokens > threshold).toBe(true);
    });
  });

  describe("sessionTokenBudget 境界値検証", () => {
    const budget = 500_000;

    it("budget 未満 (499,999 token) は block しない", () => {
      const prompt = "x".repeat(1_999_996); // 499_999 tokens
      const tokens = estimatePromptInputTokens(prompt, undefined);
      expect(tokens).toBe(499_999);
      expect(tokens > budget).toBe(false);
    });

    it("budget ちょうど (500,000 token) は block しない", () => {
      const prompt = "x".repeat(2_000_000); // 500_000 tokens
      const tokens = estimatePromptInputTokens(prompt, undefined);
      expect(tokens).toBe(500_000);
      expect(tokens > budget).toBe(false);
    });

    it("budget 超過 (500,001 token) は block する", () => {
      const prompt = "x".repeat(2_000_004); // 500_001 tokens
      const tokens = estimatePromptInputTokens(prompt, undefined);
      expect(tokens).toBe(500_001);
      expect(tokens > budget).toBe(true);
    });
  });
});
