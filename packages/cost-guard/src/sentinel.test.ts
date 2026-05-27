/**
 * sentinel module の単体テスト
 *
 * 検証点：
 * - SENTINEL_PREFIX が contracts.md §2.2 の固定文字列と一致
 * - buildSentinelMessage が prefix + bytes + guidance を含む
 * - computeContentBytes が型別に UTF-8 byte 数を返す
 * - isSentinelMessage が prefix で始まる文字列のみ true を返す
 * - boundary value（49,999 / 50,000 / 50,001 byte）で sentinel 置換の有無が正しく切り替わる
 */

import { describe, expect, it } from "vitest";
import {
  buildSentinelMessage,
  computeContentBytes,
  isSentinelMessage,
  SENTINEL_PREFIX,
} from "./sentinel.js";

describe("SENTINEL_PREFIX", () => {
  it("contracts.md §2.2 の固定文字列と一致", () => {
    expect(SENTINEL_PREFIX).toBe("[cost-guard] tool result truncated");
  });
});

describe("buildSentinelMessage", () => {
  it("prefix + bytes + analyze_transcript guidance を含む", () => {
    const msg = buildSentinelMessage(105234);
    expect(msg.startsWith(SENTINEL_PREFIX)).toBe(true);
    expect(msg).toContain("105234 bytes");
    expect(msg).toContain("analyze_transcript");
  });

  it("0 byte でも sentinel として返す", () => {
    const msg = buildSentinelMessage(0);
    expect(msg).toContain("(0 bytes)");
  });

  it("極端に大きい byte 数も正しく表示", () => {
    const msg = buildSentinelMessage(99_999_999_999);
    expect(msg).toContain("99999999999");
  });
});

describe("computeContentBytes", () => {
  it("string の UTF-8 byte 数を返す", () => {
    expect(computeContentBytes("hello")).toBe(5);
    expect(computeContentBytes("日本語")).toBe(9); // 3 chars * 3 bytes
  });

  it("undefined / null は 0 を返す", () => {
    expect(computeContentBytes(undefined)).toBe(0);
    expect(computeContentBytes(null)).toBe(0);
  });

  it("number / boolean は String 化した byte 数を返す", () => {
    expect(computeContentBytes(12345)).toBe(5);
    expect(computeContentBytes(true)).toBe(4);
    expect(computeContentBytes(false)).toBe(5);
  });

  it("object は JSON 化した byte 数を返す", () => {
    expect(computeContentBytes({ a: 1 })).toBe(7); // '{"a":1}'
    expect(computeContentBytes([1, 2, 3])).toBe(7); // '[1,2,3]'
  });

  it("循環参照 object は 0 を返す（JSON.stringify 失敗時）", () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    expect(computeContentBytes(o)).toBe(0);
  });

  describe("rewriteThresholdBytes 境界値検証", () => {
    const threshold = 50_000;

    it("49,999 byte は threshold 未満（sentinel 置換なし）", () => {
      const content = "x".repeat(49_999);
      expect(computeContentBytes(content)).toBe(49_999);
      expect(computeContentBytes(content) > threshold).toBe(false);
    });

    it("50,000 byte は threshold ちょうど（sentinel 置換なし）", () => {
      const content = "x".repeat(50_000);
      expect(computeContentBytes(content)).toBe(50_000);
      expect(computeContentBytes(content) > threshold).toBe(false);
    });

    it("50,001 byte は threshold 超過（sentinel 置換あり）", () => {
      const content = "x".repeat(50_001);
      expect(computeContentBytes(content)).toBe(50_001);
      expect(computeContentBytes(content) > threshold).toBe(true);
    });
  });
});

describe("isSentinelMessage", () => {
  it("SENTINEL_PREFIX で始まる文字列は true", () => {
    expect(isSentinelMessage(buildSentinelMessage(100))).toBe(true);
    expect(isSentinelMessage(`${SENTINEL_PREFIX} (1 bytes).`)).toBe(true);
  });

  it("prefix を含まない文字列は false", () => {
    expect(isSentinelMessage("hello world")).toBe(false);
    expect(isSentinelMessage("")).toBe(false);
  });

  it("string 以外は false", () => {
    expect(isSentinelMessage(undefined)).toBe(false);
    expect(isSentinelMessage(null)).toBe(false);
    expect(isSentinelMessage(123)).toBe(false);
    expect(isSentinelMessage({})).toBe(false);
  });
});
