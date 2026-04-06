import { describe, expect, it } from "vitest";
import { classifyMessage, shouldStickyDefault } from "./classifier.js";
import { DEFAULT_CONFIG } from "./config.js";
import type { SessionContext } from "./session-store.js";

/** SessionContext ヘルパー */
function session(
  ...reasons: Array<
    "force_default" | "token_exceeded" | "sticky_default" | "light_match" | "unmatched"
  >
): SessionContext {
  return {
    recentTurns: reasons.map((reason) => ({ reason, timestamp: Date.now() })),
  };
}

describe("classifyMessage", () => {
  // --- 既存テスト（返り値を ClassificationDetail に更新）---

  it("挨拶（短文・preferLight）→ light / light_match", () => {
    expect(classifyMessage("おはよう", DEFAULT_CONFIG)).toEqual({
      result: "light",
      reason: "light_match",
    });
  });

  it("感謝（短文・preferLight）→ light / light_match", () => {
    expect(classifyMessage("ありがとう！", DEFAULT_CONFIG)).toEqual({
      result: "light",
      reason: "light_match",
    });
  });

  it("了解（短文・preferLight）→ light / light_match", () => {
    expect(classifyMessage("了解です", DEFAULT_CONFIG)).toEqual({
      result: "light",
      reason: "light_match",
    });
  });

  it("forceDefault パターン（設計）→ default / force_default", () => {
    expect(classifyMessage("設計を見直して", DEFAULT_CONFIG)).toEqual({
      result: "default",
      reason: "force_default",
    });
  });

  it("forceDefault パターン（コード）→ default / force_default", () => {
    expect(classifyMessage("このコードをレビューして", DEFAULT_CONFIG)).toEqual({
      result: "default",
      reason: "force_default",
    });
  });

  it("長文（100 トークン超）→ default / token_exceeded", () => {
    const longMessage = "あ".repeat(101);
    expect(classifyMessage(longMessage, DEFAULT_CONFIG)).toEqual({
      result: "default",
      reason: "token_exceeded",
    });
  });

  it("パターン未一致（短文）→ default / unmatched", () => {
    expect(classifyMessage("うん", DEFAULT_CONFIG)).toEqual({
      result: "default",
      reason: "unmatched",
    });
  });

  it("空文字列 → default / unmatched", () => {
    expect(classifyMessage("", DEFAULT_CONFIG)).toEqual({
      result: "default",
      reason: "unmatched",
    });
  });

  it("forceDefault が preferLight に勝つ（優先順位確認）", () => {
    expect(classifyMessage("ありがとう、このコードで大丈夫です", DEFAULT_CONFIG)).toEqual({
      result: "default",
      reason: "force_default",
    });
  });

  it("英語 forceDefault（code）が preferLight（ok）に勝つ", () => {
    expect(classifyMessage("ok, let's write some code", DEFAULT_CONFIG)).toEqual({
      result: "default",
      reason: "force_default",
    });
  });

  it("英語 forceDefault（review）が preferLight（ok）に勝つ", () => {
    expect(classifyMessage("ok review this", DEFAULT_CONFIG)).toEqual({
      result: "default",
      reason: "force_default",
    });
  });

  it("大文字 forceDefault（Review）が preferLight（ok）に勝つ", () => {
    expect(classifyMessage("ok Review this", DEFAULT_CONFIG)).toEqual({
      result: "default",
      reason: "force_default",
    });
  });

  it("文頭大文字 Fix が preferLight（ok）に勝つ", () => {
    expect(classifyMessage("ok Fix this bug", DEFAULT_CONFIG)).toEqual({
      result: "default",
      reason: "force_default",
    });
  });

  // --- Phase 1.5: sessionContext なし → Phase 1 互換 ---

  it("sessionContext 未指定 → Phase 1 と同等の動作", () => {
    // Sticky Guard はスキップされ、preferLight が通常通り動作
    expect(classifyMessage("おはよう", DEFAULT_CONFIG)).toEqual({
      result: "light",
      reason: "light_match",
    });
  });

  // --- Phase 1.5: Sticky Default Guard ---

  it("直前が force_default → preferLight でも default 維持（sticky）", () => {
    const ctx = session("force_default");
    expect(classifyMessage("おはよう", DEFAULT_CONFIG, ctx)).toEqual({
      result: "default",
      reason: "sticky_default",
    });
  });

  it("直前が token_exceeded → preferLight でも default 維持（sticky）", () => {
    const ctx = session("token_exceeded");
    expect(classifyMessage("おはよう", DEFAULT_CONFIG, ctx)).toEqual({
      result: "default",
      reason: "sticky_default",
    });
  });

  it("直前が unmatched → sticky 不発動、preferLight が通る", () => {
    const ctx = session("unmatched");
    expect(classifyMessage("おはよう", DEFAULT_CONFIG, ctx)).toEqual({
      result: "light",
      reason: "light_match",
    });
  });

  it("直前 3 ターンすべて sticky_default → sticky 不発動（非伝播）", () => {
    const ctx = session("sticky_default", "sticky_default", "sticky_default");
    expect(classifyMessage("おはよう", DEFAULT_CONFIG, ctx)).toEqual({
      result: "light",
      reason: "light_match",
    });
  });

  it("直前 3 ターンすべて light_match → sticky 不発動", () => {
    const ctx = session("light_match", "light_match", "light_match");
    expect(classifyMessage("おはよう", DEFAULT_CONFIG, ctx)).toEqual({
      result: "light",
      reason: "light_match",
    });
  });

  it("forceDefault は Sticky Guard より優先される", () => {
    // forceDefault パターンは Layer 1 で先に判定されるため、
    // sessionContext の内容に関わらず force_default が返る
    const ctx = session("light_match", "light_match");
    expect(classifyMessage("コードをレビューして", DEFAULT_CONFIG, ctx)).toEqual({
      result: "default",
      reason: "force_default",
    });
  });
});

describe("shouldStickyDefault", () => {
  it("空の recentTurns → false", () => {
    expect(shouldStickyDefault({ recentTurns: [] }, 3)).toBe(false);
  });

  it("force_default が window 内にある → true", () => {
    const ctx = session("light_match", "force_default", "sticky_default");
    expect(shouldStickyDefault(ctx, 3)).toBe(true);
  });

  it("token_exceeded が window 内にある → true", () => {
    const ctx = session("token_exceeded");
    expect(shouldStickyDefault(ctx, 3)).toBe(true);
  });

  it("sticky_default のみ → false（非伝播）", () => {
    const ctx = session("sticky_default", "sticky_default");
    expect(shouldStickyDefault(ctx, 3)).toBe(false);
  });

  it("force_default が window 外 → false", () => {
    // windowSize=2 で、force_default は 3 ターン前
    const ctx = session("force_default", "sticky_default", "light_match");
    expect(shouldStickyDefault(ctx, 2)).toBe(false);
  });
});
