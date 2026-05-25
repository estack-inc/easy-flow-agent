/**
 * cost-guard-hello の register / hook handler の単体テスト
 *
 * 検証点：
 * - register(api) で 3 つの hook が登録される
 * - logging=false のとき log が出ない
 * - block / rewrite / outcome を変更しない（observe-only 性質）
 * - safePreview が長文を byte 上限で切り詰める
 * - npm pack 対象に OpenClaw extension が含まれる
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import register, { findBlockMatch } from "./index.js";

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

function extractParamsHead(logLine: string): string {
  const match = logLine.match(/params_head="(.*)"/);
  expect(match).not.toBeNull();
  return match![1];
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
    const paramsHead = extractParamsHead(call);
    expect(Buffer.byteLength(paramsHead, "utf8")).toBeLessThanOrEqual(200);
    expect(paramsHead.endsWith("...")).toBe(true);
  });

  it("verbose=true でマルチバイト params も 200 byte 以内に切り詰める", () => {
    const api = makeApi({ verbose: true });
    register(api as any);
    const handler = api.hooks.get("before_tool_call");
    api.logger.info.mockClear();
    const multibyteParams = { content: "日本語".repeat(100) };
    handler!({ toolName: "write", params: multibyteParams }, {});
    const call = api.logger.info.mock.calls[0][0] as string;
    const paramsHead = extractParamsHead(call);
    expect(Buffer.byteLength(paramsHead, "utf8")).toBeLessThanOrEqual(200);
    expect(paramsHead.endsWith("...")).toBe(true);
    expect(paramsHead).not.toContain("\uFFFD");
  });
});

describe("npm package metadata", () => {
  it("npm pack に OpenClaw extension の参照先ファイルを含める", () => {
    const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const packageJson = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8")) as {
      openclaw: { extensions: string[] };
    };
    execFileSync("npm", ["run", "build"], { cwd: packageDir, stdio: "pipe" });
    const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: packageDir,
      encoding: "utf8",
    });
    const [pack] = JSON.parse(output) as Array<{
      files: Array<{ path: string }>;
    }>;
    const files = new Set(pack.files.map((file) => file.path));

    expect(files.has("package.json")).toBe(true);
    for (const extension of packageJson.openclaw.extensions) {
      expect(files.has(extension.replace(/^\.\//, ""))).toBe(true);
    }
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

describe("findBlockMatch (path block 判定)", () => {
  it("string プロパティに blockPaths が含まれていたら match を返す", () => {
    const r = findBlockMatch({ path: "/data/workspace/zoom_transcribe/transcript_0415.txt" }, [
      "/data/workspace/zoom_transcribe/",
    ]);
    expect(r).not.toBeNull();
    expect(r?.matched).toBe("/data/workspace/zoom_transcribe/");
    expect(r?.field).toBe("path");
  });

  it("blockPaths にマッチしない path は null を返す", () => {
    const r = findBlockMatch({ path: "/data/workspace/note.md" }, [
      "/data/workspace/zoom_transcribe/",
    ]);
    expect(r).toBeNull();
  });

  it("blockPaths が空配列なら常に null を返す", () => {
    const r = findBlockMatch({ path: "/data/workspace/zoom_transcribe/x.txt" }, []);
    expect(r).toBeNull();
  });

  it("exec tool の command 文字列に blockPaths が含まれていたら検出する", () => {
    const r = findBlockMatch({ command: "cat /data/workspace/zoom_transcribe/transcript.txt" }, [
      "/data/workspace/zoom_transcribe/",
    ]);
    expect(r).not.toBeNull();
    expect(r?.field).toBe("command");
  });

  it("`../` を含む相対 path 混在でも canonical 化で検出する", () => {
    const r = findBlockMatch(
      { path: "/data/workspace/../workspace/zoom_transcribe/transcript.txt" },
      ["/data/workspace/zoom_transcribe/"],
    );
    expect(r).not.toBeNull();
    expect(r?.matched).toBe("/data/workspace/zoom_transcribe/");
  });

  it("ネストした object/array の中の string も検査する", () => {
    const r = findBlockMatch({ args: ["-c", "cat /data/workspace/zoom_transcribe/x.txt"] }, [
      "/data/workspace/zoom_transcribe/",
    ]);
    expect(r).not.toBeNull();
    expect(r?.field).toBe("args[1]");
  });

  it("循環参照を含む object でも無限ループしない", () => {
    const obj: Record<string, unknown> = { a: { path: "/data/workspace/note.md" } };
    (obj.a as Record<string, unknown>).self = obj;
    expect(() => findBlockMatch(obj, ["/no-match/"])).not.toThrow();
  });
});

describe("before_tool_call の block mode", () => {
  it("blockMode=observe（既定）では blockPaths に match しても block しない", () => {
    const api = makeApi({ blockPaths: ["/data/workspace/zoom_transcribe/"] });
    register(api as any);
    const handler = api.hooks.get("before_tool_call");
    const result = handler!(
      { toolName: "read", params: { path: "/data/workspace/zoom_transcribe/x.txt" } },
      {},
    );
    expect(result).toEqual({});
  });

  it("blockMode=block で blockPaths に match したら block: true を返す", () => {
    const api = makeApi({
      blockMode: "block",
      blockPaths: ["/data/workspace/zoom_transcribe/"],
    });
    register(api as any);
    const handler = api.hooks.get("before_tool_call");
    const result = handler!(
      { toolName: "read", params: { path: "/data/workspace/zoom_transcribe/x.txt" } },
      {},
    ) as { block?: boolean; blockReason?: string };
    expect(result.block).toBe(true);
    expect(result.blockReason).toContain("/data/workspace/zoom_transcribe/");
  });

  it("blockMode=block でも blockPaths が空なら block しない", () => {
    const api = makeApi({ blockMode: "block", blockPaths: [] });
    register(api as any);
    const handler = api.hooks.get("before_tool_call");
    const result = handler!(
      { toolName: "read", params: { path: "/data/workspace/zoom_transcribe/x.txt" } },
      {},
    );
    expect(result).toEqual({});
  });

  it("blockMode=block でも非マッチ path は block しない", () => {
    const api = makeApi({
      blockMode: "block",
      blockPaths: ["/data/workspace/zoom_transcribe/"],
    });
    register(api as any);
    const handler = api.hooks.get("before_tool_call");
    const result = handler!({ toolName: "read", params: { path: "/data/workspace/note.md" } }, {});
    expect(result).toEqual({});
  });

  it("block 時に warn または info で BLOCKED log を出す", () => {
    const api = makeApi({
      blockMode: "block",
      blockPaths: ["/data/workspace/zoom_transcribe/"],
    });
    register(api as any);
    const handler = api.hooks.get("before_tool_call");
    api.logger.info.mockClear();
    api.logger.warn.mockClear();
    handler!(
      { toolName: "exec", params: { command: "cat /data/workspace/zoom_transcribe/x.txt" } },
      {},
    );
    const warnCalls = api.logger.warn.mock.calls.map((c: unknown[]) => c[0] as string);
    const infoCalls = api.logger.info.mock.calls.map((c: unknown[]) => c[0] as string);
    const allCalls = [...warnCalls, ...infoCalls];
    expect(allCalls.some((m) => m.includes("BLOCKED"))).toBe(true);
  });
});
