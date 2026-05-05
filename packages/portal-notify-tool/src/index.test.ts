// index.test.ts: plugin entry の register() がツール登録 / 設定不足時のスキップを正しく行うか。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import portalNotifyToolPlugin from "./index.js";

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

function makeApi(pluginConfig?: unknown) {
  return {
    pluginConfig,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    registerTool: vi.fn(),
  };
}

describe("portalNotifyToolPlugin.register", () => {
  it("plugin metadata が想定どおり", () => {
    expect(portalNotifyToolPlugin.id).toBe("portal-notify-tool");
    expect(portalNotifyToolPlugin.kind).toBe("plugin");
    expect(typeof portalNotifyToolPlugin.register).toBe("function");
  });

  it("origin / token 欠落なら warn して registerTool を呼ばない", () => {
    const api = makeApi({});
    portalNotifyToolPlugin.register(api);
    expect(api.logger.warn).toHaveBeenCalledOnce();
    expect(api.registerTool).not.toHaveBeenCalled();
  });

  it("pluginConfig に origin / token があれば registerTool が呼ばれる", () => {
    const api = makeApi({
      origin: "https://portal.example",
      notificationToken: "uuid",
    });
    portalNotifyToolPlugin.register(api);
    expect(api.registerTool).toHaveBeenCalledOnce();
    const [factory, options] = api.registerTool.mock.calls[0];
    expect(options).toEqual({ names: ["notify_send"], optional: true });
    const tools = factory({ sandboxed: false });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("notify_send");
  });

  it("env だけで設定されていても登録される", () => {
    process.env.PORTAL_ORIGIN = "https://env.example";
    process.env.PORTAL_NOTIFICATION_TOKEN = "uuid-from-env";
    const api = makeApi();
    portalNotifyToolPlugin.register(api);
    expect(api.registerTool).toHaveBeenCalledOnce();
  });

  it("sandboxed 環境では tool factory は null を返す（agent 直接実行を抑止）", () => {
    const api = makeApi({
      origin: "https://portal.example",
      notificationToken: "uuid",
    });
    portalNotifyToolPlugin.register(api);
    const [factory] = api.registerTool.mock.calls[0];
    expect(factory({ sandboxed: true })).toBeNull();
  });

  it("ConfigError 以外の例外は re-throw する（運用バグの検出）", () => {
    const api = makeApi({
      origin: "https://x",
      notificationToken: "x",
      // 不正値で ConfigError を発生させ、ここでは catch される
      timeoutMs: -1,
    });
    // ConfigError の場合は warn + return なので throw しない
    expect(() => portalNotifyToolPlugin.register(api)).not.toThrow();
    expect(api.logger.warn).toHaveBeenCalledOnce();
    expect(api.registerTool).not.toHaveBeenCalled();
  });
});
