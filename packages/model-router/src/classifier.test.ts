import { describe, expect, it } from "vitest";
import {
  type AttachmentHint,
  classifyMessage,
  detectMediaInPrompt,
  matchMimePattern,
  routeByAttachments,
} from "./classifier.js";
import { DEFAULT_CONFIG, DEFAULT_FILE_ROUTING_RULES } from "./config.js";

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

describe("matchMimePattern", () => {
  it("完全一致", () => {
    expect(matchMimePattern("image/png", "image/png")).toBe(true);
  });

  it("不一致", () => {
    expect(matchMimePattern("image/png", "image/jpeg")).toBe(false);
  });

  it("ワイルドカード image/*", () => {
    expect(matchMimePattern("image/png", "image/*")).toBe(true);
    expect(matchMimePattern("image/jpeg", "image/*")).toBe(true);
    expect(matchMimePattern("video/mp4", "image/*")).toBe(false);
  });

  it("ワイルドカード video/*", () => {
    expect(matchMimePattern("video/mp4", "video/*")).toBe(true);
    expect(matchMimePattern("video/webm", "video/*")).toBe(true);
  });

  it("ドットワイルドカード application/vnd.openxmlformats-officedocument.*", () => {
    expect(
      matchMimePattern(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.*",
      ),
    ).toBe(true);
    expect(
      matchMimePattern(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.*",
      ),
    ).toBe(true);
  });

  it("ドットワイルドカード application/vnd.ms-*", () => {
    expect(matchMimePattern("application/vnd.ms-excel", "application/vnd.ms-*")).toBe(true);
    expect(matchMimePattern("application/vnd.ms-powerpoint", "application/vnd.ms-*")).toBe(true);
  });

  it("text/* は CSV/TSV/plain にマッチ", () => {
    expect(matchMimePattern("text/csv", "text/*")).toBe(true);
    expect(matchMimePattern("text/plain", "text/*")).toBe(true);
    expect(matchMimePattern("text/tab-separated-values", "text/*")).toBe(true);
  });
});

describe("routeByAttachments", () => {
  const rules = DEFAULT_FILE_ROUTING_RULES;

  it("画像添付 → gemini-2.5-flash", () => {
    const attachments: AttachmentHint[] = [{ kind: "image", mimeType: "image/png" }];
    const result = routeByAttachments(attachments, rules);
    expect(result).toEqual({
      model: "gemini-2.5-flash",
      provider: "google",
      matchedRule: "image",
    });
  });

  it("動画添付 → gemini-2.5-flash", () => {
    const attachments: AttachmentHint[] = [{ kind: "video", mimeType: "video/mp4" }];
    const result = routeByAttachments(attachments, rules);
    expect(result).toEqual({
      model: "gemini-2.5-flash",
      provider: "google",
      matchedRule: "video",
    });
  });

  it("音声添付 → gemini-2.5-flash", () => {
    const attachments: AttachmentHint[] = [{ kind: "audio", mimeType: "audio/mpeg" }];
    const result = routeByAttachments(attachments, rules);
    expect(result).toEqual({
      model: "gemini-2.5-flash",
      provider: "google",
      matchedRule: "audio",
    });
  });

  it("PDF 添付 → gemini-2.5-flash", () => {
    const attachments: AttachmentHint[] = [{ kind: "document", mimeType: "application/pdf" }];
    const result = routeByAttachments(attachments, rules);
    expect(result).toEqual({
      model: "gemini-2.5-flash",
      provider: "google",
      matchedRule: "document",
    });
  });

  it("Excel 添付 → gemini-2.5-flash", () => {
    const attachments: AttachmentHint[] = [
      {
        kind: "document",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    ];
    const result = routeByAttachments(attachments, rules);
    expect(result).toEqual({
      model: "gemini-2.5-flash",
      provider: "google",
      matchedRule: "document",
    });
  });

  it("Word 添付 → gemini-2.5-flash", () => {
    const attachments: AttachmentHint[] = [
      {
        kind: "document",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
    ];
    const result = routeByAttachments(attachments, rules);
    expect(result).toEqual({
      model: "gemini-2.5-flash",
      provider: "google",
      matchedRule: "document",
    });
  });

  it("CSV 添付 → gemini-2.5-flash", () => {
    const attachments: AttachmentHint[] = [{ kind: "document", mimeType: "text/csv" }];
    const result = routeByAttachments(attachments, rules);
    expect(result).toEqual({
      model: "gemini-2.5-flash",
      provider: "google",
      matchedRule: "document",
    });
  });

  it("ZIP 添付 → gemini-2.5-flash", () => {
    const attachments: AttachmentHint[] = [{ kind: "other", mimeType: "application/zip" }];
    const result = routeByAttachments(attachments, rules);
    expect(result).toEqual({
      model: "gemini-2.5-flash",
      provider: "google",
      matchedRule: "binary",
    });
  });

  it("添付なし → null", () => {
    expect(routeByAttachments([], rules)).toBeNull();
  });

  it("mimeType なし → kind ベースのフォールバック", () => {
    const attachments: AttachmentHint[] = [{ kind: "image" }];
    const result = routeByAttachments(attachments, rules);
    expect(result).toEqual({
      model: "gemini-2.5-flash",
      provider: "google",
      matchedRule: "image(kind)",
    });
  });

  it("unknown kind + unknown mimeType → null", () => {
    const attachments: AttachmentHint[] = [
      { kind: "other", mimeType: "application/x-custom-format" },
    ];
    expect(routeByAttachments(attachments, rules)).toBeNull();
  });

  it("複数添付 → 最初にマッチしたルールが適用", () => {
    const attachments: AttachmentHint[] = [
      { kind: "document", mimeType: "text/plain" },
      { kind: "image", mimeType: "image/png" },
    ];
    // image ルールが先に定義されているが、ルール順で評価
    // rules[0] = image → text/plain はマッチしない → image/png はマッチ
    const result = routeByAttachments(attachments, rules);
    expect(result).toEqual({
      model: "gemini-2.5-flash",
      provider: "google",
      matchedRule: "image",
    });
  });

  it("カスタムルール → 指定モデルにルーティング", () => {
    const customRules = [
      {
        label: "pdf-only",
        mimePatterns: ["application/pdf"],
        model: "gemini-2.5-pro",
        provider: "google",
      },
    ];
    const attachments: AttachmentHint[] = [{ kind: "document", mimeType: "application/pdf" }];
    const result = routeByAttachments(attachments, customRules);
    expect(result).toEqual({
      model: "gemini-2.5-pro",
      provider: "google",
      matchedRule: "pdf-only",
    });
  });
});

describe("detectMediaInPrompt", () => {
  it("MEDIA: /path/to/image.png → image hint", () => {
    const hints = detectMediaInPrompt("Hello\nMEDIA: /tmp/photo.png\nworld");
    expect(hints).toEqual([{ kind: "image", mimeType: "image/png" }]);
  });

  it("MEDIA: `backtick path` → image hint", () => {
    const hints = detectMediaInPrompt("MEDIA: `/data/uploads/screenshot.jpg`");
    expect(hints).toEqual([{ kind: "image", mimeType: "image/jpeg" }]);
  });

  it("MEDIA: video.mp4 → video hint", () => {
    const hints = detectMediaInPrompt("MEDIA: /tmp/clip.mp4");
    expect(hints).toEqual([{ kind: "video", mimeType: "video/mp4" }]);
  });

  it("MEDIA: audio.mp3 → audio hint", () => {
    const hints = detectMediaInPrompt("MEDIA: /tmp/voice.mp3");
    expect(hints).toEqual([{ kind: "audio", mimeType: "audio/mpeg" }]);
  });

  it("MEDIA: document.pdf → document hint", () => {
    const hints = detectMediaInPrompt("MEDIA: /tmp/report.pdf");
    expect(hints).toEqual([{ kind: "document", mimeType: "application/pdf" }]);
  });

  it("MEDIA: without extension → assume image", () => {
    const hints = detectMediaInPrompt("MEDIA: /tmp/unknown_file");
    expect(hints).toEqual([{ kind: "image" }]);
  });

  it("no MEDIA marker → empty", () => {
    const hints = detectMediaInPrompt("Just a normal message");
    expect(hints).toEqual([]);
  });

  it("multiple MEDIA markers → multiple hints", () => {
    const hints = detectMediaInPrompt("MEDIA: /a.png\nMEDIA: /b.pdf");
    expect(hints).toHaveLength(2);
    expect(hints[0]).toEqual({ kind: "image", mimeType: "image/png" });
    expect(hints[1]).toEqual({ kind: "document", mimeType: "application/pdf" });
  });
});
