import { describe, expect, it } from "vitest";
import { isWithinTtl, parseMetaSafe } from "../src/meta.js";

const VALID_META_JSON = JSON.stringify({
  filename: "report.pdf",
  mimeType: "application/pdf",
  createdAt: new Date().toISOString(),
  ttlDays: 7,
  sizeBytes: 1024,
});

describe("parseMetaSafe", () => {
  describe("正常系", () => {
    it("正常な meta.json → FileMeta を返す", () => {
      const result = parseMetaSafe(VALID_META_JSON);

      expect(result).not.toBeNull();
      expect(result?.filename).toBe("report.pdf");
      expect(result?.mimeType).toBe("application/pdf");
      expect(result?.ttlDays).toBe(7);
      expect(result?.sizeBytes).toBe(1024);
    });

    it("ttlDays=1（下限）→ 通過する", () => {
      const json = JSON.stringify({
        filename: "f.pdf",
        mimeType: "application/pdf",
        createdAt: new Date().toISOString(),
        ttlDays: 1,
        sizeBytes: 0,
      });
      expect(parseMetaSafe(json)).not.toBeNull();
    });

    it("ttlDays=3650（上限）→ 通過する", () => {
      const json = JSON.stringify({
        filename: "f.pdf",
        mimeType: "application/pdf",
        createdAt: new Date().toISOString(),
        ttlDays: 3650,
        sizeBytes: 0,
      });
      expect(parseMetaSafe(json)).not.toBeNull();
    });

    it("sizeBytes=0 → 通過する", () => {
      const json = JSON.stringify({
        filename: "f.pdf",
        mimeType: "application/pdf",
        createdAt: new Date().toISOString(),
        ttlDays: 7,
        sizeBytes: 0,
      });
      expect(parseMetaSafe(json)).not.toBeNull();
    });
  });

  describe("JSON パースエラー", () => {
    it("不正な JSON → null を返す", () => {
      expect(parseMetaSafe("{invalid json")).toBeNull();
    });

    it("空文字列 → null を返す", () => {
      expect(parseMetaSafe("")).toBeNull();
    });

    it("配列 → null を返す（オブジェクトでない）", () => {
      expect(parseMetaSafe("[1,2,3]")).toBeNull();
    });

    it("null JSON → null を返す", () => {
      expect(parseMetaSafe("null")).toBeNull();
    });
  });

  describe("filename バリデーション", () => {
    it("filename に / を含む → null（パス区切り文字）", () => {
      const json = JSON.stringify({
        filename: "../../etc/passwd",
        mimeType: "application/pdf",
        createdAt: new Date().toISOString(),
        ttlDays: 7,
        sizeBytes: 1024,
      });
      expect(parseMetaSafe(json)).toBeNull();
    });

    it("filename に \\ を含む → null（Windows パス区切り文字）", () => {
      const json = JSON.stringify({
        filename: "dir\\file.pdf",
        mimeType: "application/pdf",
        createdAt: new Date().toISOString(),
        ttlDays: 7,
        sizeBytes: 1024,
      });
      expect(parseMetaSafe(json)).toBeNull();
    });

    it("filename が空文字列 → null", () => {
      const json = JSON.stringify({
        filename: "",
        mimeType: "application/pdf",
        createdAt: new Date().toISOString(),
        ttlDays: 7,
        sizeBytes: 1024,
      });
      expect(parseMetaSafe(json)).toBeNull();
    });

    it("filename が数値型 → null", () => {
      const json = JSON.stringify({
        filename: 123,
        mimeType: "application/pdf",
        createdAt: new Date().toISOString(),
        ttlDays: 7,
        sizeBytes: 1024,
      });
      expect(parseMetaSafe(json)).toBeNull();
    });
  });

  describe("mimeType バリデーション", () => {
    it("mimeType がスラッシュなし → null", () => {
      const json = JSON.stringify({
        filename: "f.pdf",
        mimeType: "applicationpdf",
        createdAt: new Date().toISOString(),
        ttlDays: 7,
        sizeBytes: 1024,
      });
      expect(parseMetaSafe(json)).toBeNull();
    });

    it("mimeType が空文字列 → null", () => {
      const json = JSON.stringify({
        filename: "f.pdf",
        mimeType: "",
        createdAt: new Date().toISOString(),
        ttlDays: 7,
        sizeBytes: 1024,
      });
      expect(parseMetaSafe(json)).toBeNull();
    });

    it("mimeType が改行文字を含む → null（ヘッダーインジェクション防止）", () => {
      const json = JSON.stringify({
        filename: "f.pdf",
        mimeType: "application/pdf\r\nX-Evil: header",
        createdAt: new Date().toISOString(),
        ttlDays: 7,
        sizeBytes: 1024,
      });
      expect(parseMetaSafe(json)).toBeNull();
    });
  });

  describe("createdAt バリデーション", () => {
    it("createdAt が不正な日付文字列 → null（NaN ガード）", () => {
      const json = JSON.stringify({
        filename: "f.pdf",
        mimeType: "application/pdf",
        createdAt: "not-a-date",
        ttlDays: 7,
        sizeBytes: 1024,
      });
      expect(parseMetaSafe(json)).toBeNull();
    });

    it("createdAt が数値型 → null", () => {
      const json = JSON.stringify({
        filename: "f.pdf",
        mimeType: "application/pdf",
        createdAt: 1234567890,
        ttlDays: 7,
        sizeBytes: 1024,
      });
      expect(parseMetaSafe(json)).toBeNull();
    });
  });

  describe("ttlDays バリデーション", () => {
    it("ttlDays=0 → null（0以下は無効）", () => {
      const json = JSON.stringify({
        filename: "f.pdf",
        mimeType: "application/pdf",
        createdAt: new Date().toISOString(),
        ttlDays: 0,
        sizeBytes: 1024,
      });
      expect(parseMetaSafe(json)).toBeNull();
    });

    it("ttlDays=-1 → null（負数）", () => {
      const json = JSON.stringify({
        filename: "f.pdf",
        mimeType: "application/pdf",
        createdAt: new Date().toISOString(),
        ttlDays: -1,
        sizeBytes: 1024,
      });
      expect(parseMetaSafe(json)).toBeNull();
    });

    it("ttlDays=3651 → null（上限超え）", () => {
      const json = JSON.stringify({
        filename: "f.pdf",
        mimeType: "application/pdf",
        createdAt: new Date().toISOString(),
        ttlDays: 3651,
        sizeBytes: 1024,
      });
      expect(parseMetaSafe(json)).toBeNull();
    });

    it("ttlDays が文字列 → null", () => {
      const json = JSON.stringify({
        filename: "f.pdf",
        mimeType: "application/pdf",
        createdAt: new Date().toISOString(),
        ttlDays: "7",
        sizeBytes: 1024,
      });
      expect(parseMetaSafe(json)).toBeNull();
    });
  });

  describe("sizeBytes バリデーション", () => {
    it("sizeBytes=-1 → null（負数）", () => {
      const json = JSON.stringify({
        filename: "f.pdf",
        mimeType: "application/pdf",
        createdAt: new Date().toISOString(),
        ttlDays: 7,
        sizeBytes: -1,
      });
      expect(parseMetaSafe(json)).toBeNull();
    });

    it("sizeBytes=Infinity → null（非有限）", () => {
      // JSON.stringify で Infinity は null になるが、文字列として渡すケースを想定
      const json =
        '{"filename":"f.pdf","mimeType":"application/pdf","createdAt":"2026-01-01T00:00:00.000Z","ttlDays":7,"sizeBytes":1e999}';
      expect(parseMetaSafe(json)).toBeNull();
    });

    it("sizeBytes が文字列 → null", () => {
      const json = JSON.stringify({
        filename: "f.pdf",
        mimeType: "application/pdf",
        createdAt: new Date().toISOString(),
        ttlDays: 7,
        sizeBytes: "1024",
      });
      expect(parseMetaSafe(json)).toBeNull();
    });
  });

  describe("必須フィールド欠落", () => {
    it("filename が欠落 → null", () => {
      const json = JSON.stringify({
        mimeType: "application/pdf",
        createdAt: new Date().toISOString(),
        ttlDays: 7,
        sizeBytes: 1024,
      });
      expect(parseMetaSafe(json)).toBeNull();
    });

    it("mimeType が欠落 → null", () => {
      const json = JSON.stringify({
        filename: "f.pdf",
        createdAt: new Date().toISOString(),
        ttlDays: 7,
        sizeBytes: 1024,
      });
      expect(parseMetaSafe(json)).toBeNull();
    });

    it("createdAt が欠落 → null", () => {
      const json = JSON.stringify({
        filename: "f.pdf",
        mimeType: "application/pdf",
        ttlDays: 7,
        sizeBytes: 1024,
      });
      expect(parseMetaSafe(json)).toBeNull();
    });
  });
});

describe("isWithinTtl", () => {
  it("作成から ttlDays 日未満 → true（期限内）", () => {
    const meta = {
      filename: "f.pdf",
      mimeType: "application/pdf",
      createdAt: new Date(Date.now() - 6 * 86400000).toISOString(),
      ttlDays: 7,
      sizeBytes: 1024,
    };
    expect(isWithinTtl(meta)).toBe(true);
  });

  it("作成から ttlDays 日超過 → false（期限切れ）", () => {
    const meta = {
      filename: "f.pdf",
      mimeType: "application/pdf",
      createdAt: new Date(Date.now() - 8 * 86400000).toISOString(),
      ttlDays: 7,
      sizeBytes: 1024,
    };
    expect(isWithinTtl(meta)).toBe(false);
  });

  it("createdAt が不正な日付 → false（NaN ガード）", () => {
    const meta = {
      filename: "f.pdf",
      mimeType: "application/pdf",
      createdAt: "invalid-date",
      ttlDays: 7,
      sizeBytes: 1024,
    };
    expect(isWithinTtl(meta)).toBe(false);
  });
});
