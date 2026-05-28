/**
 * redaction の単体テスト
 *
 * 検証点：
 * - 6 種類の redaction（participant / meeting_name / email / phone / address / credential）
 * - excerpt 制約：1 件 500 文字 / 合計 2000 文字
 */

import { describe, expect, it } from "vitest";
import {
  applyExcerptLimits,
  MAX_EXCERPT_CHARS_PER_CITATION,
  MAX_TOTAL_EXCERPT_CHARS,
  redactForListSummary,
  redactSensitive,
} from "./redaction.js";

describe("redactSensitive", () => {
  it("email を REDACTED_EMAIL に置換", () => {
    const { text, redactions } = redactSensitive("contact: foo@example.com です");
    expect(text).toContain("[REDACTED_EMAIL]");
    expect(text).not.toContain("foo@example.com");
    expect(redactions.some((r) => r.type === "email")).toBe(true);
  });

  it("phone を REDACTED_PHONE に置換", () => {
    const { text, redactions } = redactSensitive("電話：090-1234-5678 まで");
    expect(text).toContain("[REDACTED_PHONE]");
    expect(text).not.toContain("090-1234-5678");
    expect(redactions.some((r) => r.type === "phone")).toBe(true);
  });

  it("participant ラベル付き名前を REDACTED_PARTICIPANT に置換", () => {
    const { text, redactions } = redactSensitive("参加者: 山田太郎\n本日の議題は...");
    expect(text).toContain("[REDACTED_PARTICIPANT]");
    expect(text).not.toContain("山田太郎");
    expect(redactions.some((r) => r.type === "participant")).toBe(true);
  });

  it("participant ラベル付きの複数参加者をすべて REDACTED_PARTICIPANT に置換", () => {
    const { text, redactions } = redactSensitive("参加者: 山田太郎, 佐藤花子、鈴木一郎\n本文");
    expect(text).toContain("[REDACTED_PARTICIPANT]");
    expect(text).not.toContain("山田太郎");
    expect(text).not.toContain("佐藤花子");
    expect(text).not.toContain("鈴木一郎");
    expect(text).toContain("\n本文");
    expect(redactions.some((r) => r.type === "participant")).toBe(true);
  });

  it("meeting_name ラベル付き件名を REDACTED_MEETING に置換", () => {
    const { text, redactions } = redactSensitive("件名: 月次商談レビュー（社外秘）\n本文...");
    expect(text).toContain("[REDACTED_MEETING]");
    expect(text).not.toContain("月次商談レビュー");
    expect(redactions.some((r) => r.type === "meeting_name")).toBe(true);
  });

  it("address を REDACTED_ADDRESS に置換", () => {
    const { text, redactions } = redactSensitive("所在地：東京都港区南青山1-2-3");
    expect(text).toContain("[REDACTED_ADDRESS]");
    expect(redactions.some((r) => r.type === "address")).toBe(true);
  });

  it("credential を REDACTED_CREDENTIAL に置換", () => {
    const { text, redactions } = redactSensitive("api_key=sk_live_abc123 を保管");
    expect(text).toContain("[REDACTED_CREDENTIAL]");
    expect(text).not.toContain("sk_live_abc123");
    expect(redactions.some((r) => r.type === "credential")).toBe(true);
  });

  it("複数種類の redaction を 1 回で処理", () => {
    const input =
      "件名: 月例MTG\n参加者: 田中花子\n連絡先：tanaka@example.com / 090-1234-5678\napi_key=secret_xyz";
    const { text, redactions } = redactSensitive(input);
    const types = new Set(redactions.map((r) => r.type));
    expect(types.has("email")).toBe(true);
    expect(types.has("phone")).toBe(true);
    expect(types.has("credential")).toBe(true);
    expect(types.has("meeting_name")).toBe(true);
    expect(types.has("participant")).toBe(true);
    expect(text).not.toContain("田中花子");
    expect(text).not.toContain("tanaka@example.com");
  });

  it("空文字列を安全に扱う", () => {
    const { text, redactions } = redactSensitive("");
    expect(text).toBe("");
    expect(redactions).toEqual([]);
  });

  it("非 string も安全に扱う", () => {
    const { text } = redactSensitive(undefined as unknown as string);
    expect(text).toBe("");
  });

  it("redaction.original_length が元 token 長と一致", () => {
    const email = "user@example.com";
    const { redactions } = redactSensitive(`連絡: ${email}`);
    const emailRed = redactions.find((r) => r.type === "email");
    expect(emailRed).toBeDefined();
    expect(emailRed?.original_length).toBe(email.length);
  });
});

describe("applyExcerptLimits", () => {
  it("1 件 500 文字を超えた excerpt を truncate", () => {
    const long = "a".repeat(600);
    const limited = applyExcerptLimits([long]);
    expect(limited[0].length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS_PER_CITATION);
    expect(limited[0].endsWith("...")).toBe(true);
  });

  it("合計 2000 文字を超えると末尾を truncate/drop", () => {
    // 各 500 文字 × 5 件 = 2500 文字
    const items = Array.from({ length: 5 }, () => "b".repeat(500));
    const limited = applyExcerptLimits(items);
    const total = limited.reduce((s, e) => s + e.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_EXCERPT_CHARS);
  });

  it("空配列を空配列で返す", () => {
    expect(applyExcerptLimits([])).toEqual([]);
  });

  it("制限内なら原文をそのまま返す", () => {
    const items = ["短い", "短い文章"];
    expect(applyExcerptLimits(items)).toEqual(items);
  });
});

describe("redactForListSummary", () => {
  it("null / undefined / 空文字列は null を返す", () => {
    expect(redactForListSummary(null)).toBeNull();
    expect(redactForListSummary(undefined)).toBeNull();
    expect(redactForListSummary("")).toBeNull();
  });

  it("80 文字以内に truncate", () => {
    const long = "件名: ".concat("a".repeat(200));
    const out = redactForListSummary(long);
    expect(out).not.toBeNull();
    expect((out as string).length).toBeLessThanOrEqual(80);
  });

  it("redact が適用される", () => {
    const out = redactForListSummary("件名: 月例MTG\n参加者: 田中花子\nemail: x@y.com");
    expect(out).not.toBeNull();
    expect(out).toContain("[REDACTED_");
  });
});
