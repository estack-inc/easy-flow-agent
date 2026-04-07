import { describe, expect, it, vi } from "vitest";

import register from "./index.js";

type MockApi = {
  pluginConfig: Record<string, unknown>;
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
  registerHook: ReturnType<typeof vi.fn>;
};

function createMockApi(pluginConfig: Record<string, unknown> = {}): MockApi {
  return {
    pluginConfig,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerHook: vi.fn(),
  };
}

type HookHandler = (
  e: { prompt?: string } | null,
  ctx: Record<string, unknown> | undefined,
) => unknown;

function getHandler(api: MockApi): HookHandler {
  const [, handler] = api.registerHook.mock.calls[0] as [string[], HookHandler];
  return handler;
}

function callHook(api: MockApi, prompt: string, ctx: Record<string, unknown> = {}) {
  return getHandler(api)({ prompt }, ctx);
}

function registerPlugin(pluginConfig: Record<string, unknown> = {}): MockApi {
  const api = createMockApi(pluginConfig);
  register(api as unknown as import("openclaw/plugin-sdk").OpenClawPluginApi);
  return api;
}

describe("model-router plugin", () => {
  // --- 既存テスト ---

  it("before_model_resolve フックを登録する", () => {
    const api = registerPlugin();
    expect(api.registerHook).toHaveBeenCalledWith(["before_model_resolve"], expect.any(Function));
  });

  it("登録後に info ログを出力する", () => {
    const api = registerPlugin();
    expect(api.logger.info).toHaveBeenCalledWith("[model-router] plugin registered");
  });

  it("軽量タスク → { modelOverride, providerOverride } を返す", () => {
    const api = registerPlugin();
    const result = callHook(api, "おはよう");
    expect(result).toEqual({
      modelOverride: "claude-haiku-4-5",
      providerOverride: "anthropic",
    });
  });

  it("複雑タスク → void(デフォルトモデル維持)", () => {
    const api = registerPlugin();
    const result = callHook(api, "このコードをレビューして");
    expect(result).toBeUndefined();
  });

  it("logging: true のとき軽量ルーティングで reason 付き info ログを出力する", () => {
    const api = registerPlugin({ logging: true });
    callHook(api, "おはよう");
    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("reason: light_match"));
  });

  it("logging: false のとき軽量ルーティングで info ログを出力しない", () => {
    const api = registerPlugin({ logging: false });
    const infoCallsBefore = api.logger.info.mock.calls.length;
    callHook(api, "おはよう");
    expect(api.logger.info.mock.calls.length).toBe(infoCallsBefore);
  });

  it("pluginConfig.patterns でデフォルト設定を上書きできる", () => {
    const api = registerPlugin({
      patterns: { preferLight: ["hello"], forceDefault: [] },
    });
    const lightResult = callHook(api, "hello");
    expect(lightResult).toEqual({
      modelOverride: "claude-haiku-4-5",
      providerOverride: "anthropic",
    });

    const api2 = registerPlugin({
      patterns: { preferLight: ["hello"], forceDefault: [] },
    });
    const defaultResult = callHook(api2, "おはよう");
    expect(defaultResult).toBeUndefined();
  });

  it("ハンドラ内で例外が発生しても void を返す(デフォルトモデル維持)", () => {
    const api = registerPlugin();
    const handler = getHandler(api);
    const result = handler(null, {});
    expect(result).toBeUndefined();
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("[model-router] classify error:"),
    );
  });

  // --- Phase 1.5: セッションコンテキスト統合テスト ---

  it("Sticky Default: 複雑タスク後の軽量メッセージが default 維持", () => {
    const api = registerPlugin();
    const ctx = { sessionKey: "line:user1" };

    const r1 = callHook(api, "このコードをレビューして", ctx);
    expect(r1).toBeUndefined();

    const r2 = callHook(api, "おはよう", ctx);
    expect(r2).toBeUndefined();
  });

  it("Sticky Default: sticky_default は伝播せず自然解除される", () => {
    const api = registerPlugin({ stickyWindowSize: 2 });
    const ctx = { sessionKey: "line:user1" };

    callHook(api, "コードをレビューして", ctx);
    callHook(api, "はい", ctx);
    callHook(api, "了解", ctx);
    const r4 = callHook(api, "おはよう", ctx);
    expect(r4).toEqual({
      modelOverride: "claude-haiku-4-5",
      providerOverride: "anthropic",
    });
  });

  it("異なる sessionKey は独立したセッションとして扱われる", () => {
    const api = registerPlugin();

    callHook(api, "コードをレビューして", { sessionKey: "line:userA" });

    const result = callHook(api, "おはよう", { sessionKey: "slack:C123" });
    expect(result).toEqual({
      modelOverride: "claude-haiku-4-5",
      providerOverride: "anthropic",
    });
  });

  it("enableSessionContext: false → Sticky Guard 無効(Phase 1 互換)", () => {
    const api = registerPlugin({ enableSessionContext: false });
    const ctx = { sessionKey: "line:user1" };

    callHook(api, "コードをレビューして", ctx);

    const result = callHook(api, "おはよう", ctx);
    expect(result).toEqual({
      modelOverride: "claude-haiku-4-5",
      providerOverride: "anthropic",
    });
  });

  it("ctx が undefined でもエラーにならない", () => {
    const api = registerPlugin();
    const handler = getHandler(api);
    const result = handler({ prompt: "おはよう" }, undefined);
    expect(result).toEqual({
      modelOverride: "claude-haiku-4-5",
      providerOverride: "anthropic",
    });
  });

  it("初回フック呼び出し時に ctx shape をログ出力する", () => {
    const api = registerPlugin({ logging: true });
    callHook(api, "おはよう", { sessionKey: "line:user1", runId: "r1" });
    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("ctx shape:"));
  });
});
