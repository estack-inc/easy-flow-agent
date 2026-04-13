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
  on: ReturnType<typeof vi.fn>;
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
    on: vi.fn(),
  };
}

/** 登録済みの before_model_resolve ハンドラを取得して呼び出す */
function callHook(
  api: MockApi,
  event: { prompt?: string; attachments?: { kind: string; mimeType?: string }[] },
) {
  const [, handler] = api.on.mock.calls[0] as [string, (e: unknown, ctx: unknown) => unknown];
  return handler(event, {});
}

describe("model-router plugin", () => {
  it("before_model_resolve フックを登録する", () => {
    const api = createMockApi();
    register(api as unknown as import("openclaw/plugin-sdk").OpenClawPluginApi);

    expect(api.on).toHaveBeenCalledWith("before_model_resolve", expect.any(Function));
  });

  it("登録後に info ログを出力する", () => {
    const api = createMockApi();
    register(api as unknown as import("openclaw/plugin-sdk").OpenClawPluginApi);

    expect(api.logger.info).toHaveBeenCalledWith("[model-router] plugin registered");
  });

  it("軽量タスク → { modelOverride, providerOverride } を返す", () => {
    const api = createMockApi();
    register(api as unknown as import("openclaw/plugin-sdk").OpenClawPluginApi);

    const result = callHook(api, { prompt: "おはよう" });

    expect(result).toEqual({
      modelOverride: "claude-haiku-4-5",
      providerOverride: "anthropic",
    });
  });

  it("複雑タスク → void（デフォルトモデル維持）", () => {
    const api = createMockApi();
    register(api as unknown as import("openclaw/plugin-sdk").OpenClawPluginApi);

    const result = callHook(api, { prompt: "このコードをレビューして" });

    expect(result).toBeUndefined();
  });

  // ===== ファイルルーティング =====

  it("画像添付 → Gemini Flash にルーティング", () => {
    const api = createMockApi();
    register(api as unknown as import("openclaw/plugin-sdk").OpenClawPluginApi);

    const result = callHook(api, {
      prompt: "この画像を見て",
      attachments: [{ kind: "image", mimeType: "image/png" }],
    });

    expect(result).toEqual({
      modelOverride: "gemini-2.5-flash",
      providerOverride: "google",
    });
  });

  it("PDF 添付 → Gemini Flash にルーティング", () => {
    const api = createMockApi();
    register(api as unknown as import("openclaw/plugin-sdk").OpenClawPluginApi);

    const result = callHook(api, {
      prompt: "この資料を要約して",
      attachments: [{ kind: "document", mimeType: "application/pdf" }],
    });

    expect(result).toEqual({
      modelOverride: "gemini-2.5-flash",
      providerOverride: "google",
    });
  });

  it("Excel 添付 → Gemini Flash にルーティング", () => {
    const api = createMockApi();
    register(api as unknown as import("openclaw/plugin-sdk").OpenClawPluginApi);

    const result = callHook(api, {
      prompt: "売上データを分析して",
      attachments: [
        {
          kind: "document",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      ],
    });

    expect(result).toEqual({
      modelOverride: "gemini-2.5-flash",
      providerOverride: "google",
    });
  });

  it("ファイル添付がテキスト分類より優先される", () => {
    const api = createMockApi();
    register(api as unknown as import("openclaw/plugin-sdk").OpenClawPluginApi);

    // "おはよう" は preferLight だが、画像添付があるので Gemini にルーティング
    const result = callHook(api, {
      prompt: "おはよう",
      attachments: [{ kind: "image", mimeType: "image/jpeg" }],
    });

    expect(result).toEqual({
      modelOverride: "gemini-2.5-flash",
      providerOverride: "google",
    });
  });

  it("添付なし + 軽量テキスト → Haiku", () => {
    const api = createMockApi();
    register(api as unknown as import("openclaw/plugin-sdk").OpenClawPluginApi);

    const result = callHook(api, {
      prompt: "おはよう",
      attachments: [],
    });

    expect(result).toEqual({
      modelOverride: "claude-haiku-4-5",
      providerOverride: "anthropic",
    });
  });

  it("fileRouting.enabled: false → ファイルルーティング無効", () => {
    const api = createMockApi({ fileRouting: { enabled: false } });
    register(api as unknown as import("openclaw/plugin-sdk").OpenClawPluginApi);

    const result = callHook(api, {
      prompt: "おはよう",
      attachments: [{ kind: "image", mimeType: "image/png" }],
    });

    // ファイルルーティング無効なので、テキスト分類が適用
    expect(result).toEqual({
      modelOverride: "claude-haiku-4-5",
      providerOverride: "anthropic",
    });
  });

  it("カスタム fileRouting.rules が適用される", () => {
    const api = createMockApi({
      fileRouting: {
        enabled: true,
        rules: [
          {
            label: "custom-image",
            mimePatterns: ["image/*"],
            model: "gemini-2.5-pro",
            provider: "google",
          },
        ],
      },
    });
    register(api as unknown as import("openclaw/plugin-sdk").OpenClawPluginApi);

    const result = callHook(api, {
      prompt: "分析して",
      attachments: [{ kind: "image", mimeType: "image/png" }],
    });

    expect(result).toEqual({
      modelOverride: "gemini-2.5-pro",
      providerOverride: "google",
    });
  });

  // ===== 既存テスト（後方互換性） =====

  it("logging: true のとき軽量ルーティングで info ログを出力する", () => {
    const api = createMockApi({ logging: true });
    register(api as unknown as import("openclaw/plugin-sdk").OpenClawPluginApi);
    callHook(api, { prompt: "おはよう" });

    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("anthropic/claude-haiku-4-5"),
    );
  });

  it("logging: false のとき軽量ルーティングで info ログを出力しない", () => {
    const api = createMockApi({ logging: false });
    register(api as unknown as import("openclaw/plugin-sdk").OpenClawPluginApi);

    // info は "plugin registered" のみ呼ばれる
    const infoCallsBefore = api.logger.info.mock.calls.length;
    callHook(api, { prompt: "おはよう" });

    expect(api.logger.info.mock.calls.length).toBe(infoCallsBefore);
  });

  it("logging: true のときファイルルーティングで info ログを出力する", () => {
    const api = createMockApi({ logging: true });
    register(api as unknown as import("openclaw/plugin-sdk").OpenClawPluginApi);
    callHook(api, {
      prompt: "この画像は何？",
      attachments: [{ kind: "image", mimeType: "image/png" }],
    });

    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("google/gemini-2.5-flash"),
    );
    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("file: image"));
  });

  it("pluginConfig.patterns でデフォルト設定を上書きできる", () => {
    const api = createMockApi({
      patterns: {
        preferLight: ["hello"],
        forceDefault: [],
      },
    });
    register(api as unknown as import("openclaw/plugin-sdk").OpenClawPluginApi);

    // カスタム preferLight にマッチ → light
    const lightResult = callHook(api, { prompt: "hello" });
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
    register(api2 as unknown as import("openclaw/plugin-sdk").OpenClawPluginApi);
    const defaultResult = callHook(api2, { prompt: "おはよう" });
    expect(defaultResult).toBeUndefined();
  });

  it("ハンドラ内で例外が発生しても void を返す（デフォルトモデル維持）", () => {
    const api = createMockApi();
    register(api as unknown as import("openclaw/plugin-sdk").OpenClawPluginApi);

    // ハンドラに null を渡して event.prompt アクセスで例外を発生させる
    const [, handler] = api.on.mock.calls[0] as [string, (e: unknown, ctx: unknown) => unknown];
    const result = handler(null, {});

    expect(result).toBeUndefined();
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("[model-router] classify error:"),
    );
  });
});
