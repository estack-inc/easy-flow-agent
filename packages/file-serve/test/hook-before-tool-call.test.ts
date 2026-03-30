import { beforeEach, describe, expect, it, vi } from "vitest";

// storage をモック
vi.mock("../src/storage.js", () => ({
  saveFile: vi.fn(),
}));

// node:fs をモック（PDF サイズ取得用）
vi.mock("node:fs", () => ({
  default: {
    promises: {
      stat: vi.fn().mockResolvedValue({ size: 2048 }),
    },
  },
}));

import type { FileServeConfig } from "../src/config.js";
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookToolContext,
} from "../src/hook-before-tool-call.js";
import { createBeforeToolCallHook } from "../src/hook-before-tool-call.js";
import { saveFile } from "../src/storage.js";

const baseConfig: FileServeConfig = {
  storageDir: "/data/file-serve",
  baseUrl: "https://example.fly.dev",
  ttlDays: 7,
  rateLimit: { windowMs: 60000, maxRequests: 30 },
};

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function makeEvent(
  overrides?: Partial<PluginHookBeforeToolCallEvent>,
): PluginHookBeforeToolCallEvent {
  return {
    toolName: "message",
    params: { filePath: "/tmp/report.png" },
    ...overrides,
  };
}

function makeCtx(overrides?: Partial<PluginHookToolContext>): PluginHookToolContext {
  return {
    toolName: "message",
    sessionKey: "line:user123",
    ...overrides,
  };
}

describe("createBeforeToolCallHook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("LINE + PNG → params.media が配信 URL に書き換わる、params.filePath が undefined", async () => {
    const servedUrl = "https://example.fly.dev/files/uuid-1/report.png";
    (saveFile as ReturnType<typeof vi.fn>).mockResolvedValue({
      uuid: "uuid-1",
      servedUrl,
    });

    const hook = createBeforeToolCallHook(baseConfig, mockLogger);
    const result = await hook(
      makeEvent({ params: { filePath: "/tmp/report.png" } }),
      makeCtx({ sessionKey: "line:user123" }),
    );

    expect(result).toBeDefined();
    expect(result?.params?.media).toBe(servedUrl);
    expect(result?.params?.filePath).toBeUndefined();
  });

  it("LINE + PDF → params.message が Flex Message JSON、type === 'flex'、params.filePath が undefined", async () => {
    const servedUrl = "https://example.fly.dev/files/uuid-2/document.pdf";
    (saveFile as ReturnType<typeof vi.fn>).mockResolvedValue({
      uuid: "uuid-2",
      servedUrl,
    });

    const hook = createBeforeToolCallHook(baseConfig, mockLogger);
    const result = await hook(
      makeEvent({ params: { filePath: "/tmp/document.pdf" } }),
      makeCtx({ sessionKey: "line:user123" }),
    );

    expect(result).toBeDefined();
    expect(typeof result?.params?.message).toBe("string");
    const flexMsg = JSON.parse(result?.params?.message as string);
    expect(flexMsg.type).toBe("flex");
    expect(result?.params?.filePath).toBeUndefined();
    expect(result?.params?.media).toBeUndefined();
  });

  it("Slack → 戻り値が undefined（何も変更しない）", async () => {
    const hook = createBeforeToolCallHook(baseConfig, mockLogger);
    const result = await hook(
      makeEvent({ params: { filePath: "/tmp/report.png" } }),
      makeCtx({ sessionKey: "slack:C0123456" }),
    );

    expect(result).toBeUndefined();
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("filePath も media もなし → 戻り値が undefined", async () => {
    const hook = createBeforeToolCallHook(baseConfig, mockLogger);
    const result = await hook(
      makeEvent({ params: { text: "hello" } }),
      makeCtx({ sessionKey: "line:user123" }),
    );

    expect(result).toBeUndefined();
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("toolName が message 以外 → 戻り値が undefined", async () => {
    const hook = createBeforeToolCallHook(baseConfig, mockLogger);
    const result = await hook(
      makeEvent({ toolName: "search", params: { filePath: "/tmp/report.png" } }),
      makeCtx({ sessionKey: "line:user123" }),
    );

    expect(result).toBeUndefined();
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("saveFile 失敗時 → logger.error を呼び出し undefined を返す", async () => {
    (saveFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("disk full"));

    const hook = createBeforeToolCallHook(baseConfig, mockLogger);
    const result = await hook(
      makeEvent({ params: { filePath: "/tmp/report.png" } }),
      makeCtx({ sessionKey: "line:user123" }),
    );

    expect(result).toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("ファイル保存失敗"));
  });

  it("filePath の代わりに media を入力ソースとして渡した場合 → params.media が配信 URL に書き換わる", async () => {
    const servedUrl = "https://example.fly.dev/files/uuid-3/banner.png";
    (saveFile as ReturnType<typeof vi.fn>).mockResolvedValue({
      uuid: "uuid-3",
      servedUrl,
    });

    const hook = createBeforeToolCallHook(baseConfig, mockLogger);
    const result = await hook(
      makeEvent({ params: { media: "/tmp/banner.png" } }),
      makeCtx({ sessionKey: "line:user123" }),
    );

    expect(result).toBeDefined();
    expect(result?.params?.media).toBe(servedUrl);
    expect(result?.params?.filePath).toBeUndefined();
  });
});
