import { describe, expect, it, vi } from "vitest";

// definePluginEntry は引数をそのまま返すモック（テスト環境では openclaw 未インストール）
vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
  definePluginEntry: (entry: { register: (api: unknown) => void }) => entry,
}));

import plugin from "./index.js";

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

/** 登録済みの before_model_resolve ハンドラを取得して呼び出す */
function callHook(api: MockApi, prompt: string) {
  const [, handler] = api.registerHook.mock.calls[0] as [
    string[],
    (e: { prompt: string }, ctx: unknown) => unknown,
  ];
  return handler({ prompt }, {});
}

describe("model-router plugin", () => {
  it("before_model_resolve フックを登録する", () => {
    const api = createMockApi();
    (plugin as unknown as { register: (api: unknown) => void }).register(api);

    expect(api.registerHook).toHaveBeenCalledWith(["before_model_resolve"], expect.any(Function));
  });

  it("登録後に info ログを出力する", () => {
    const api = createMockApi();
    (plugin as unknown as { register: (api: unknown) => void }).register(api);

    expect(api.logger.info).toHaveBeenCalledWith("[model-router] plugin registered");
  });

  it("軽量タスク → { modelOverride, providerOverride } を返す", () => {
    const api = createMockApi();
    (plugin as unknown as { register: (api: unknown) => void }).register(api);

    const result = callHook(api, "おはよう");

    expect(result).toEqual({
      modelOverride: "claude-haiku-4-5",
      providerOverride: "anthropic",
    });
  });

  it("複雑タスク → void（デフォルトモデル維持）", () => {
    const api = createMockApi();
    (plugin as unknown as { register: (api: unknown) => void }).register(api);

    const result = callHook(api, "このコードをレビューして");

    expect(result).toBeUndefined();
  });

  it("logging: true のとき軽量ルーティングで info ログを出力する", () => {
    const api = createMockApi({ logging: true });
    (plugin as unknown as { register: (api: unknown) => void }).register(api);
    callHook(api, "おはよう");

    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("anthropic/claude-haiku-4-5"),
    );
  });

  it("logging: false のとき軽量ルーティングで info ログを出力しない", () => {
    const api = createMockApi({ logging: false });
    (plugin as unknown as { register: (api: unknown) => void }).register(api);

    // info は "plugin registered" のみ呼ばれる
    const infoCallsBefore = api.logger.info.mock.calls.length;
    callHook(api, "おはよう");

    expect(api.logger.info.mock.calls.length).toBe(infoCallsBefore);
  });

  it("pluginConfig.patterns でデフォルト設定を上書きできる", () => {
    const api = createMockApi({
      patterns: {
        preferLight: ["hello"],
        forceDefault: [],
      },
    });
    (plugin as unknown as { register: (api: unknown) => void }).register(api);

    // カスタム preferLight にマッチ → light
    const lightResult = callHook(api, "hello");
    expect(lightResult).toEqual({
      modelOverride: "claude-haiku-4-5",
      providerOverride: "anthropic",
    });

    // デフォルトの preferLight（おはよう）はオーバーライドされているのでマッチしない → void
    const api2 = createMockApi({
      patterns: {
        preferLight: ["hello"],
        forceDefault: [],
      },
    });
    (plugin as unknown as { register: (api: unknown) => void }).register(api2);
    const defaultResult = callHook(api2, "おはよう");
    expect(defaultResult).toBeUndefined();
  });

  it("ハンドラ内で例外が発生しても void を返す（デフォルトモデル維持）", () => {
    const api = createMockApi();
    (plugin as unknown as { register: (api: unknown) => void }).register(api);

    // ハンドラに null を渡して event.prompt アクセスで例外を発生させる
    const [, handler] = api.registerHook.mock.calls[0] as [
      string[],
      (e: unknown, ctx: unknown) => unknown,
    ];
    const result = handler(null, {});

    expect(result).toBeUndefined();
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("[model-router] classify error:"),
    );
  });
});
