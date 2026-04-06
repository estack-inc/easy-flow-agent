import { describe, expect, it } from "vitest";
import { classifyMessage } from "./classifier.js";
import { DEFAULT_CONFIG } from "./config.js";

describe("classifyMessage", () => {
  it("挨拶（短文・preferLight）→ light", () => {
    expect(classifyMessage("おはよう", DEFAULT_CONFIG)).toBe("light");
  });

  it("感謝（短文・preferLight）→ light", () => {
    expect(classifyMessage("ありがとう！", DEFAULT_CONFIG)).toBe("light");
  });

  it("了解（短文・preferLight）→ light", () => {
    expect(classifyMessage("了解です", DEFAULT_CONFIG)).toBe("light");
  });

  it("forceDefault パターン（設計）→ default", () => {
    expect(classifyMessage("設計を見直して", DEFAULT_CONFIG)).toBe("default");
  });

  it("forceDefault パターン（コード）→ default", () => {
    expect(classifyMessage("このコードをレビューして", DEFAULT_CONFIG)).toBe("default");
  });

  it("長文（100トークン超）→ default", () => {
    const longMessage = "あ".repeat(101); // 日本語 101 文字 = 101 トークン（maxTokensForLight: 100 超）
    expect(classifyMessage(longMessage, DEFAULT_CONFIG)).toBe("default");
  });

  it("パターン未一致（短文）→ default", () => {
    expect(classifyMessage("うん", DEFAULT_CONFIG)).toBe("default");
  });

  it("空文字列 → default", () => {
    expect(classifyMessage("", DEFAULT_CONFIG)).toBe("default");
  });

  it("forceDefault が preferLight に勝つ（優先順位確認）", () => {
    // 「ありがとう」+ 「コード」が混在 → forceDefault 優先で default
    expect(classifyMessage("ありがとう、このコードで大丈夫です", DEFAULT_CONFIG)).toBe("default");
  });

  it("英語 forceDefault（code）が preferLight（ok）に勝つ", () => {
    // "ok" が preferLight にマッチするが "code" が forceDefault にマッチ → default
    expect(classifyMessage("ok, let's write some code", DEFAULT_CONFIG)).toBe("default");
  });

  it("英語 forceDefault（review）が preferLight（ok）に勝つ", () => {
    expect(classifyMessage("ok review this", DEFAULT_CONFIG)).toBe("default");
  });

  it("大文字 forceDefault（Review）が preferLight（ok）に勝つ", () => {
    expect(classifyMessage("ok Review this", DEFAULT_CONFIG)).toBe("default");
  });

  it("文頭大文字 Fix が preferLight（ok）に勝つ", () => {
    expect(classifyMessage("ok Fix this bug", DEFAULT_CONFIG)).toBe("default");
  });

  it("「〜を確認して」はパターン未一致で default（複雑タスク）", () => {
    expect(classifyMessage("このPRを確認して", DEFAULT_CONFIG)).toBe("default");
  });
});
