/**
 * cost-guard-hello の register / hook handler の単体テスト
 *
 * 検証点：
 * - register(api) で 3 つの hook が登録される
 * - logging=false のとき log が出ない
 * - block / rewrite / outcome を変更しない（observe-only 性質）
 * - safePreview が長文を切り詰める
 */

import { describe, expect, it, vi } from "vitest";
import register from "./index.js";

type HookHandler = (event: unknown, ctx: unknown) => unknown;

interface MockApi {
  pluginConfig: Record<string, unknown>;
  logger: {
    info: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  on: ReturnType<typeof vi.fn>;
  hooks: Map<string, HookHandler>;
}

function makeApi(config: Record<string, unknown> = {}): MockApi {
  const hooks = new Map<string, HookHandler>();
  return {
    pluginConfig: config,
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    on: vi.fn((event: string, handler: HookHandler) => {
      hooks.set(event, handler);
    }),
    hooks,
  };
}

describe("cost-guard-hello register", () => {
  it("3 つの hook（before_tool_call / tool_result_persist / before_agent_run）を登録する", () => {
    const api = makeApi();
    register(api as any);
    expect(api.hooks.has("before_tool_call")).toBe(true);
    expect(api.hooks.has("tool_result_persist")).toBe(true);
    expect(api.hooks.has("before_agent_run")).toBe(true);
  });

  it("起動時に register log を出力する", () => {
    const api = makeApi();
    register(api as any);
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("[cost-guard-hello] registered"),
    );
  });
});

describe("before_tool_call handler", () => {
  it("空オブジェクトを返して block しない", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("before_tool_call");
    expect(handler).toBeDefined();
    const result = handler!({ toolName: "read", params: { path: "/data/workspace/x.txt" } }, {});
    expect(result).toEqual({});
  });

  it("logging=true のときに log を出す", () => {
    const api = makeApi({ logging: true });
    register(api as any);
    const handler = api.hooks.get("before_tool_call");
    api.logger.info.mockClear();
    handler!({ toolName: "read", params: { path: "/data/x.txt" } }, {});
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("before_tool_call: tool=read"),
    );
  });

  it("logging=false のときは log を出さない", () => {
    const api = makeApi({ logging: false });
    register(api as any);
    const handler = api.hooks.get("before_tool_call");
    api.logger.info.mockClear();
    handler!({ toolName: "read", params: {} }, {});
    expect(api.logger.info).not.toHaveBeenCalled();
  });

  it("verbose=true のときに params の冒頭を log に含める", () => {
    const api = makeApi({ verbose: true });
    register(api as any);
    const handler = api.hooks.get("before_tool_call");
    api.logger.info.mockClear();
    handler!({ toolName: "read", params: { path: "/data/workspace/x.txt" } }, {});
    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining('params_head="'));
  });

  it("verbose=true で巨大な params は 200 byte で切り詰める", () => {
    const api = makeApi({ verbose: true });
    register(api as any);
    const handler = api.hooks.get("before_tool_call");
    api.logger.info.mockClear();
    const hugeParams = { content: "x".repeat(1000) };
    handler!({ toolName: "write", params: hugeParams }, {});
    const call = api.logger.info.mock.calls[0][0] as string;
    // params_head="..." の中身は 200 文字 + "..." で切れている
    expect(call).toMatch(/params_head=".{200,}\.\.\."/);
  });
});

describe("tool_result_persist handler", () => {
  it("空オブジェクトを返して rewrite しない", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("tool_result_persist");
    const result = handler!({ toolName: "read", toolCallId: "tcid_1", isSynthetic: false }, {});
    expect(result).toEqual({});
  });

  it("logging=true で log を出力する", () => {
    const api = makeApi({ logging: true });
    register(api as any);
    const handler = api.hooks.get("tool_result_persist");
    api.logger.info.mockClear();
    handler!({ toolName: "read", toolCallId: "tcid_1", isSynthetic: false }, {});
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("tool_result_persist: tool=read"),
    );
  });
});

describe("before_agent_run handler", () => {
  it("常に { outcome: 'pass' } を返す（pure observer）", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("before_agent_run");
    const result = handler!(
      { prompt: "hello", messages: [], accountId: "U1", channelId: "C1", senderIsOwner: true },
      {},
    );
    expect(result).toEqual({ outcome: "pass" });
  });

  it("prompt_len と message count を log に含める", () => {
    const api = makeApi({ logging: true });
    register(api as any);
    const handler = api.hooks.get("before_agent_run");
    api.logger.info.mockClear();
    handler!({ prompt: "hello world", messages: [1, 2, 3], accountId: "U1", channelId: "C1" }, {});
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("before_agent_run: prompt_len=11 messages=3"),
    );
  });

  it("logging=false でも pass は返す（block ではない）", () => {
    const api = makeApi({ logging: false });
    register(api as any);
    const handler = api.hooks.get("before_agent_run");
    api.logger.info.mockClear();
    const result = handler!({ prompt: "", messages: [] }, {});
    expect(result).toEqual({ outcome: "pass" });
    expect(api.logger.info).not.toHaveBeenCalled();
  });
});
