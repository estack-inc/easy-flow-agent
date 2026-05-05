// resolveConfig: pluginConfig > env > 既定値 の 3 段階優先のテスト。
//
// すべての閾値（timeout / retry 配列 / pending 設定）は外部設定で上書き可能であり、
// ハードコーディング禁止のルールに従っていることを検証する。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PORTAL_NOTIFY_CONFIG, resolveConfig } from "./config.js";
import { PortalNotifyConfigError } from "./types.js";

const ENV_KEYS = [
  "PORTAL_ORIGIN",
  "PORTAL_NOTIFICATION_TOKEN",
  "PORTAL_NOTIFY_TIMEOUT_MS",
  "PORTAL_NOTIFY_RETRY_FAILED_MS",
  "PORTAL_NOTIFY_RETRY_PENDING_MS",
  "PORTAL_NOTIFY_RETRY_PENDING_MAX",
];

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("resolveConfig", () => {
  describe("必須項目", () => {
    it("origin / notificationToken が両方無いと PortalNotifyConfigError", () => {
      expect(() => resolveConfig({})).toThrow(PortalNotifyConfigError);
    });

    it("origin だけある場合も PortalNotifyConfigError", () => {
      expect(() => resolveConfig({ origin: "https://portal.example" })).toThrow(
        PortalNotifyConfigError,
      );
    });

    it("notificationToken だけある場合も PortalNotifyConfigError", () => {
      expect(() => resolveConfig({ notificationToken: "uuid" })).toThrow(PortalNotifyConfigError);
    });

    it("pluginConfig で両方与えれば既定値で resolve される", () => {
      const cfg = resolveConfig({
        origin: "https://portal.example",
        notificationToken: "11111111-2222-4333-8444-555555555555",
      });
      expect(cfg).toEqual({
        origin: "https://portal.example",
        notificationToken: "11111111-2222-4333-8444-555555555555",
        timeoutMs: DEFAULT_PORTAL_NOTIFY_CONFIG.timeoutMs,
        retryFailedDelaysMs: DEFAULT_PORTAL_NOTIFY_CONFIG.retryFailedDelaysMs,
        retryPendingDelayMs: DEFAULT_PORTAL_NOTIFY_CONFIG.retryPendingDelayMs,
        retryPendingMaxAttempts: DEFAULT_PORTAL_NOTIFY_CONFIG.retryPendingMaxAttempts,
      });
    });

    it("env だけで両方与えても resolve される", () => {
      process.env.PORTAL_ORIGIN = "https://env.example";
      process.env.PORTAL_NOTIFICATION_TOKEN = "uuid-from-env";
      const cfg = resolveConfig();
      expect(cfg.origin).toBe("https://env.example");
      expect(cfg.notificationToken).toBe("uuid-from-env");
    });
  });

  describe("優先順 pluginConfig > env > default", () => {
    it("pluginConfig が env を上書きする", () => {
      process.env.PORTAL_ORIGIN = "https://env.example";
      process.env.PORTAL_NOTIFICATION_TOKEN = "uuid-env";
      const cfg = resolveConfig({
        origin: "https://plugin.example",
        notificationToken: "uuid-plugin",
      });
      expect(cfg.origin).toBe("https://plugin.example");
      expect(cfg.notificationToken).toBe("uuid-plugin");
    });

    it("timeoutMs は pluginConfig 指定が最優先", () => {
      process.env.PORTAL_NOTIFY_TIMEOUT_MS = "9000";
      const cfg = resolveConfig({
        origin: "https://x",
        notificationToken: "x",
        timeoutMs: 1234,
      });
      expect(cfg.timeoutMs).toBe(1234);
    });

    it("timeoutMs は pluginConfig 未指定なら env が使われる", () => {
      process.env.PORTAL_NOTIFY_TIMEOUT_MS = "9000";
      const cfg = resolveConfig({ origin: "https://x", notificationToken: "x" });
      expect(cfg.timeoutMs).toBe(9000);
    });

    it("timeoutMs は env も無ければ default に倒れる", () => {
      const cfg = resolveConfig({ origin: "https://x", notificationToken: "x" });
      expect(cfg.timeoutMs).toBe(DEFAULT_PORTAL_NOTIFY_CONFIG.timeoutMs);
    });
  });

  describe("配列パース", () => {
    it("retryFailedDelaysMs は env 文字列をカンマ区切りで int 配列に変換", () => {
      process.env.PORTAL_NOTIFY_RETRY_FAILED_MS = "100,200,400";
      const cfg = resolveConfig({ origin: "https://x", notificationToken: "x" });
      expect(cfg.retryFailedDelaysMs).toEqual([100, 200, 400]);
    });

    it("retryFailedDelaysMs は pluginConfig 配列を尊重する", () => {
      process.env.PORTAL_NOTIFY_RETRY_FAILED_MS = "100,200,400";
      const cfg = resolveConfig({
        origin: "https://x",
        notificationToken: "x",
        retryFailedDelaysMs: [1, 2, 3],
      });
      expect(cfg.retryFailedDelaysMs).toEqual([1, 2, 3]);
    });

    it("retryFailedDelaysMs は空配列 [] も尊重する（retry 無効化を意味する）", () => {
      const cfg = resolveConfig({
        origin: "https://x",
        notificationToken: "x",
        retryFailedDelaysMs: [],
      });
      expect(cfg.retryFailedDelaysMs).toEqual([]);
    });

    it("env の retryFailedDelaysMs に非数値が混じれば PortalNotifyConfigError", () => {
      process.env.PORTAL_NOTIFY_RETRY_FAILED_MS = "100,abc,300";
      expect(() => resolveConfig({ origin: "https://x", notificationToken: "x" })).toThrow(
        PortalNotifyConfigError,
      );
    });
  });

  describe("数値パース", () => {
    it("retryPendingMaxAttempts は env 文字列を整数に変換", () => {
      process.env.PORTAL_NOTIFY_RETRY_PENDING_MAX = "3";
      const cfg = resolveConfig({ origin: "https://x", notificationToken: "x" });
      expect(cfg.retryPendingMaxAttempts).toBe(3);
    });

    it("retryPendingMaxAttempts は 0 を「pending retry 無効」として尊重する", () => {
      const cfg = resolveConfig({
        origin: "https://x",
        notificationToken: "x",
        retryPendingMaxAttempts: 0,
      });
      expect(cfg.retryPendingMaxAttempts).toBe(0);
    });

    it("env の数値が不正なら PortalNotifyConfigError", () => {
      process.env.PORTAL_NOTIFY_TIMEOUT_MS = "not-a-number";
      expect(() => resolveConfig({ origin: "https://x", notificationToken: "x" })).toThrow(
        PortalNotifyConfigError,
      );
    });

    it("env の数値が負数なら PortalNotifyConfigError", () => {
      process.env.PORTAL_NOTIFY_TIMEOUT_MS = "-100";
      expect(() => resolveConfig({ origin: "https://x", notificationToken: "x" })).toThrow(
        PortalNotifyConfigError,
      );
    });
  });

  describe("DEFAULT_PORTAL_NOTIFY_CONFIG の妥当性", () => {
    it("retryFailedDelaysMs は単調増加（指数バックオフ）", () => {
      const ds = DEFAULT_PORTAL_NOTIFY_CONFIG.retryFailedDelaysMs;
      for (let i = 1; i < ds.length; i++) {
        expect(ds[i]).toBeGreaterThan(ds[i - 1]);
      }
    });

    it("すべての既定値が正の数", () => {
      expect(DEFAULT_PORTAL_NOTIFY_CONFIG.timeoutMs).toBeGreaterThan(0);
      expect(DEFAULT_PORTAL_NOTIFY_CONFIG.retryPendingDelayMs).toBeGreaterThan(0);
      expect(DEFAULT_PORTAL_NOTIFY_CONFIG.retryPendingMaxAttempts).toBeGreaterThanOrEqual(0);
    });
  });
});
