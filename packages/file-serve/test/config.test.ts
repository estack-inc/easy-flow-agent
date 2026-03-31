import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  describe("baseUrl 解決", () => {
    it("pluginConfig.baseUrl が設定されている場合に優先される", () => {
      const config = loadConfig({ baseUrl: "https://custom.example.com" }, undefined);
      expect(config.baseUrl).toBe("https://custom.example.com");
    });

    it("末尾スラッシュは除去される", () => {
      const config = loadConfig({ baseUrl: "https://custom.example.com/" }, undefined);
      expect(config.baseUrl).toBe("https://custom.example.com");
    });

    it("apiConfig.publicUrl が次の優先順位", () => {
      const config = loadConfig(undefined, { publicUrl: "https://api-public.example.com" });
      expect(config.baseUrl).toBe("https://api-public.example.com");
    });

    it("pluginConfig.baseUrl が apiConfig.publicUrl より優先される", () => {
      const config = loadConfig(
        { baseUrl: "https://plugin.example.com" },
        { publicUrl: "https://api.example.com" },
      );
      expect(config.baseUrl).toBe("https://plugin.example.com");
    });

    it("FLY_APP_NAME 環境変数からフォールバック", () => {
      const original = process.env.FLY_APP_NAME;
      process.env.FLY_APP_NAME = "my-app";
      try {
        const config = loadConfig(undefined, undefined);
        expect(config.baseUrl).toBe("https://my-app.fly.dev");
      } finally {
        if (original === undefined) {
          delete process.env.FLY_APP_NAME;
        } else {
          process.env.FLY_APP_NAME = original;
        }
      }
    });

    it("全フォールバック未設定時は localhost:8080", () => {
      const original = process.env.FLY_APP_NAME;
      delete process.env.FLY_APP_NAME;
      try {
        const config = loadConfig(undefined, undefined);
        expect(config.baseUrl).toBe("http://localhost:8080");
      } finally {
        if (original !== undefined) {
          process.env.FLY_APP_NAME = original;
        }
      }
    });

    it("不正な URL → エラーをスロー", () => {
      expect(() => loadConfig({ baseUrl: "not-a-url" }, undefined)).toThrow(
        "baseUrl が不正な URL です",
      );
    });

    it("空文字列の baseUrl → 未設定扱いでフォールバック（localhost:8080）", () => {
      const original = process.env.FLY_APP_NAME;
      delete process.env.FLY_APP_NAME;
      try {
        // 空文字列は falsy なので pluginConfig.baseUrl 条件を満たさずフォールバックされる
        const config = loadConfig({ baseUrl: "" }, undefined);
        expect(config.baseUrl).toBe("http://localhost:8080");
      } finally {
        if (original !== undefined) {
          process.env.FLY_APP_NAME = original;
        }
      }
    });
  });

  describe("ttlDays バリデーション", () => {
    it("正常な値はそのまま使用される", () => {
      const config = loadConfig({ baseUrl: "https://example.com", ttlDays: 14 }, undefined);
      expect(config.ttlDays).toBe(14);
    });

    it("ttlDays=0 → デフォルト 7 にフォールバック（0以下は無効）", () => {
      const config = loadConfig({ baseUrl: "https://example.com", ttlDays: 0 }, undefined);
      expect(config.ttlDays).toBe(7);
    });

    it("ttlDays=-1 → デフォルト 7 にフォールバック", () => {
      const config = loadConfig({ baseUrl: "https://example.com", ttlDays: -1 }, undefined);
      expect(config.ttlDays).toBe(7);
    });

    it("ttlDays=3651 → デフォルト 7 にフォールバック（上限超え）", () => {
      const config = loadConfig({ baseUrl: "https://example.com", ttlDays: 3651 }, undefined);
      expect(config.ttlDays).toBe(7);
    });

    it("ttlDays=3650 → 有効な上限値", () => {
      const config = loadConfig({ baseUrl: "https://example.com", ttlDays: 3650 }, undefined);
      expect(config.ttlDays).toBe(3650);
    });

    it("ttlDays が文字列 → デフォルト 7 にフォールバック", () => {
      const config = loadConfig({ baseUrl: "https://example.com", ttlDays: "14" }, undefined);
      expect(config.ttlDays).toBe(7);
    });

    it("ttlDays 未設定 → デフォルト 7", () => {
      const config = loadConfig({ baseUrl: "https://example.com" }, undefined);
      expect(config.ttlDays).toBe(7);
    });
  });

  describe("rateLimit バリデーション", () => {
    it("windowMs が正常な値はそのまま使用される", () => {
      const config = loadConfig(
        { baseUrl: "https://example.com", rateLimit: { windowMs: 30000, maxRequests: 60 } },
        undefined,
      );
      expect(config.rateLimit.windowMs).toBe(30000);
    });

    it("windowMs < 1000ms → デフォルト 60000 にフォールバック", () => {
      const config = loadConfig(
        { baseUrl: "https://example.com", rateLimit: { windowMs: 999, maxRequests: 30 } },
        undefined,
      );
      expect(config.rateLimit.windowMs).toBe(60000);
    });

    it("windowMs=0 → デフォルト 60000 にフォールバック", () => {
      const config = loadConfig(
        { baseUrl: "https://example.com", rateLimit: { windowMs: 0, maxRequests: 30 } },
        undefined,
      );
      expect(config.rateLimit.windowMs).toBe(60000);
    });

    it("maxRequests が正常な値はそのまま使用される", () => {
      const config = loadConfig(
        { baseUrl: "https://example.com", rateLimit: { windowMs: 60000, maxRequests: 100 } },
        undefined,
      );
      expect(config.rateLimit.maxRequests).toBe(100);
    });

    it("maxRequests=0 → デフォルト 30 にフォールバック（1未満は無効）", () => {
      const config = loadConfig(
        { baseUrl: "https://example.com", rateLimit: { windowMs: 60000, maxRequests: 0 } },
        undefined,
      );
      expect(config.rateLimit.maxRequests).toBe(30);
    });

    it("maxRequests=10001 → デフォルト 30 にフォールバック（上限超え）", () => {
      const config = loadConfig(
        { baseUrl: "https://example.com", rateLimit: { windowMs: 60000, maxRequests: 10001 } },
        undefined,
      );
      expect(config.rateLimit.maxRequests).toBe(30);
    });

    it("rateLimit 未設定 → デフォルト windowMs=60000, maxRequests=30", () => {
      const config = loadConfig({ baseUrl: "https://example.com" }, undefined);
      expect(config.rateLimit).toEqual({ windowMs: 60000, maxRequests: 30 });
    });
  });

  describe("storageDir バリデーション", () => {
    it("storageDir が設定されている場合はそのまま使用される", () => {
      const config = loadConfig(
        { baseUrl: "https://example.com", storageDir: "/custom/storage" },
        undefined,
      );
      expect(config.storageDir).toBe("/custom/storage");
    });

    it("storageDir 未設定 → デフォルト /data/file-serve", () => {
      const config = loadConfig({ baseUrl: "https://example.com" }, undefined);
      expect(config.storageDir).toBe("/data/file-serve");
    });

    it("storageDir が空文字列 → デフォルト /data/file-serve にフォールバック", () => {
      const config = loadConfig({ baseUrl: "https://example.com", storageDir: "" }, undefined);
      expect(config.storageDir).toBe("/data/file-serve");
    });
  });

  describe("allowedSourceDir バリデーション", () => {
    it("allowedSourceDir が設定されている場合はそのまま使用される", () => {
      const config = loadConfig(
        { baseUrl: "https://example.com", allowedSourceDir: "/tmp/uploads" },
        undefined,
      );
      expect(config.allowedSourceDir).toBe("/tmp/uploads");
    });

    it("allowedSourceDir 未設定 → undefined", () => {
      const config = loadConfig({ baseUrl: "https://example.com" }, undefined);
      expect(config.allowedSourceDir).toBeUndefined();
    });

    it("allowedSourceDir が空文字列 → undefined にフォールバック", () => {
      const config = loadConfig(
        { baseUrl: "https://example.com", allowedSourceDir: "" },
        undefined,
      );
      expect(config.allowedSourceDir).toBeUndefined();
    });
  });
});
