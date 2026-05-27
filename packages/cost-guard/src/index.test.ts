/**
 * cost-guard index.ts（hook 登録 + 3 hook 実装）の単体テスト
 *
 * 検証点：
 * - register(api) で 3 hook が登録される
 * - configSchema のデフォルト値（contracts.md §9.1）が反映される
 * - before_tool_call：denyPaths block / allowlist 例外 / commandDenylist / observe mode
 * - tool_result_persist：rewriteThresholdBytes 境界値 / sentinel 置換 / tool_call_id 保持
 * - before_agent_run：suspendAgent / 段 1 per-turn gate / 段 2 session budget / cleanup
 * - metric 発行（cost_guard.*）
 * - npm pack に OpenClaw extension が含まれる
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import register, {
  type BeforeAgentRunResult,
  type BeforeToolCallResult,
  SENTINEL_PREFIX,
  type ToolResultPersistResult,
} from "./index.js";

type HookHandler = (event: unknown, ctx: unknown) => unknown;

interface MockApi {
  pluginConfig: Record<string, unknown>;
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  metrics: {
    incrementCounter: ReturnType<typeof vi.fn>;
    setGauge: ReturnType<typeof vi.fn>;
  };
  on: ReturnType<typeof vi.fn>;
  hooks: Map<string, HookHandler>;
}

function makeApi(config: Record<string, unknown> = {}): MockApi {
  const hooks = new Map<string, HookHandler>();
  return {
    pluginConfig: config,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { incrementCounter: vi.fn(), setGauge: vi.fn() },
    on: vi.fn((event: string, handler: HookHandler) => {
      hooks.set(event, handler);
    }),
    hooks,
  };
}

const DENY = "/data/workspace/zoom_transcribe/";

// ----------------------------------------------------------------------------
// register
// ----------------------------------------------------------------------------

describe("register", () => {
  it("3 hook（before_tool_call / tool_result_persist / before_agent_run）を登録", () => {
    const api = makeApi();
    register(api as any);
    expect(api.hooks.has("before_tool_call")).toBe(true);
    expect(api.hooks.has("tool_result_persist")).toBe(true);
    expect(api.hooks.has("before_agent_run")).toBe(true);
  });

  it("起動時に register log を出力", () => {
    const api = makeApi();
    register(api as any);
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("[cost-guard] registered"),
    );
  });

  it("既定 config（blockMode=block / denyPaths / allowlist）が反映される", () => {
    const api = makeApi();
    register(api as any);
    const registerLog = api.logger.info.mock.calls[0][0] as string;
    expect(registerLog).toContain("blockMode=block");
    expect(registerLog).toContain("/data/workspace/zoom_transcribe");
  });
});

// ----------------------------------------------------------------------------
// before_tool_call: denyPaths + allowlist + commandDenylist
// ----------------------------------------------------------------------------

describe("before_tool_call - denyPaths block", () => {
  it("blockMode=block で denyPaths 配下への generic read を block", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("before_tool_call")!;
    const result = handler(
      { toolId: "read", params: { path: `${DENY}transcript.txt` } },
      {},
    ) as BeforeToolCallResult;
    expect((result as any).block).toBe(true);
    expect((result as any).blockReason).toBe("deny_path_match");
    expect((result as any).message).toContain("transcript-analyzer");
  });

  it("blockMode=block で denyPaths 配下への generic exec を block", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("before_tool_call")!;
    const result = handler(
      { toolId: "exec", params: { command: `cat ${DENY}transcript.txt` } },
      {},
    ) as BeforeToolCallResult;
    expect((result as any).block).toBe(true);
  });

  it("allowlist 内 tool（transcript-analyzer.list_transcripts）は通過", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("before_tool_call")!;
    const result = handler(
      {
        toolId: "transcript-analyzer.list_transcripts",
        params: { path: `${DENY}transcript.txt` },
      },
      {},
    ) as BeforeToolCallResult;
    expect(result).toEqual({});
  });

  it("allowlist 内 tool（transcript-analyzer.search_transcripts）は通過", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("before_tool_call")!;
    const result = handler(
      {
        toolId: "transcript-analyzer.search_transcripts",
        params: { query: "hello", dir: DENY },
      },
      {},
    ) as BeforeToolCallResult;
    expect(result).toEqual({});
  });

  it("allowlist 内 tool（transcript-analyzer.analyze_transcript）は通過", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("before_tool_call")!;
    const result = handler(
      {
        toolId: "transcript-analyzer.analyze_transcript",
        params: { transcript_id: "xx", query: "hello" },
      },
      {},
    ) as BeforeToolCallResult;
    expect(result).toEqual({});
  });

  it("denyPaths 外の path は通過", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("before_tool_call")!;
    const result = handler({ toolId: "read", params: { path: "/data/workspace/note.md" } }, {});
    expect(result).toEqual({});
  });

  it("blockMode=observe では block しないが metric は発行", () => {
    const api = makeApi({ blockMode: "observe" });
    register(api as any);
    const handler = api.hooks.get("before_tool_call")!;
    const result = handler({ toolId: "read", params: { path: `${DENY}transcript.txt` } }, {});
    expect(result).toEqual({});
    expect(api.metrics.incrementCounter).toHaveBeenCalledWith(
      "cost_guard.tool_call_blocked",
      expect.objectContaining({ blockReason: "deny_path_match" }),
    );
  });

  it("block 時に metric `cost_guard.tool_call_blocked` を発行", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("before_tool_call")!;
    handler({ toolId: "read", params: { path: `${DENY}x.txt` } }, {});
    expect(api.metrics.incrementCounter).toHaveBeenCalledWith(
      "cost_guard.tool_call_blocked",
      expect.objectContaining({ blockReason: "deny_path_match", toolId: "read" }),
    );
  });

  it("block 時に warn log を出力", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("before_tool_call")!;
    api.logger.warn.mockClear();
    handler({ toolId: "read", params: { path: `${DENY}x.txt` } }, {});
    const warnCalls = api.logger.warn.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(warnCalls.some((m) => m.includes("BLOCKED"))).toBe(true);
  });
});

describe("before_tool_call - commandDenylist", () => {
  it("eval を含む command を block", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("before_tool_call")!;
    const result = handler(
      { toolId: "exec", params: { command: "eval $(cat /tmp/x.sh)" } },
      {},
    ) as BeforeToolCallResult;
    expect((result as any).block).toBe(true);
    expect((result as any).blockReason).toBe("command_denylist_match");
  });

  it("commandDenylist match は denyPaths match より優先", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("before_tool_call")!;
    const result = handler(
      { toolId: "exec", params: { command: `eval ${DENY}x.txt` } },
      {},
    ) as BeforeToolCallResult;
    expect((result as any).blockReason).toBe("command_denylist_match");
  });

  it("空の commandDenylist では何も block しない", () => {
    const api = makeApi({ commandDenylist: [] });
    register(api as any);
    const handler = api.hooks.get("before_tool_call")!;
    const result = handler({ toolId: "exec", params: { command: "eval $(cat /tmp/x.sh)" } }, {});
    expect(result).toEqual({});
  });
});

// ----------------------------------------------------------------------------
// tool_result_persist: sentinel rewrite boundary
// ----------------------------------------------------------------------------

describe("tool_result_persist - sentinel boundary", () => {
  it("rewriteThresholdBytes 未満（49,999 byte）は置換しない", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("tool_result_persist")!;
    const result = handler(
      {
        toolId: "read",
        toolCallId: "tcid_001",
        result: { content: "x".repeat(49_999) },
      },
      {},
    ) as ToolResultPersistResult;
    expect(result).toEqual({});
  });

  it("rewriteThresholdBytes ちょうど（50,000 byte）は置換しない（境界は超過ではない）", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("tool_result_persist")!;
    const result = handler(
      {
        toolId: "read",
        toolCallId: "tcid_002",
        result: { content: "x".repeat(50_000) },
      },
      {},
    ) as ToolResultPersistResult;
    expect(result).toEqual({});
  });

  it("rewriteThresholdBytes 超過（50,001 byte）は sentinel 置換", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("tool_result_persist")!;
    const result = handler(
      {
        toolId: "read",
        toolCallId: "tcid_003",
        result: { content: "x".repeat(50_001) },
      },
      {},
    ) as ToolResultPersistResult;
    expect((result as any).message).toBeDefined();
    expect((result as any).message.role).toBe("tool");
    expect((result as any).message.tool_call_id).toBe("tcid_003");
    expect((result as any).message.content).toContain(SENTINEL_PREFIX);
    expect((result as any).message.content).toContain("50001 bytes");
  });

  it("sentinel 置換時に tool_call_id を保持", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("tool_result_persist")!;
    const result = handler(
      {
        toolId: "read",
        toolCallId: "tcid_preserve_me",
        result: { content: "x".repeat(60_000) },
      },
      {},
    ) as ToolResultPersistResult;
    expect((result as any).message.tool_call_id).toBe("tcid_preserve_me");
  });

  it("string 直結 result でも byte 数計算", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("tool_result_persist")!;
    const result = handler(
      { toolId: "read", toolCallId: "tcid_str", result: "x".repeat(60_000) },
      {},
    ) as ToolResultPersistResult;
    expect((result as any).message).toBeDefined();
  });

  it("rewriteThresholdBytes をカスタム値（1000）に設定", () => {
    const api = makeApi({ rewriteThresholdBytes: 1000 });
    register(api as any);
    const handler = api.hooks.get("tool_result_persist")!;
    const result = handler(
      { toolId: "read", toolCallId: "tcid_x", result: { content: "x".repeat(1001) } },
      {},
    ) as ToolResultPersistResult;
    expect((result as any).message).toBeDefined();
  });

  it("置換時に metric `cost_guard.tool_result_rewritten` を発行", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("tool_result_persist")!;
    handler({ toolId: "read", toolCallId: "tcid_m", result: { content: "x".repeat(60_000) } }, {});
    expect(api.metrics.incrementCounter).toHaveBeenCalledWith(
      "cost_guard.tool_result_rewritten",
      expect.objectContaining({ toolId: "read" }),
    );
  });

  it("blockMode=observe では metric は発行するが置換しない", () => {
    const api = makeApi({ blockMode: "observe" });
    register(api as any);
    const handler = api.hooks.get("tool_result_persist")!;
    const result = handler(
      { toolId: "read", toolCallId: "tcid_obs", result: { content: "x".repeat(60_000) } },
      {},
    );
    expect(result).toEqual({});
    expect(api.metrics.incrementCounter).toHaveBeenCalledWith(
      "cost_guard.tool_result_rewritten",
      expect.anything(),
    );
  });

  it("result.content が配列（[{text: '...'}, ...]）形式でも byte 数を合算", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("tool_result_persist")!;
    const result = handler(
      {
        toolId: "read",
        toolCallId: "tcid_arr",
        result: {
          content: [{ text: "x".repeat(30_000) }, { text: "y".repeat(30_000) }],
        },
      },
      {},
    ) as ToolResultPersistResult;
    expect((result as any).message).toBeDefined();
    expect((result as any).message.content).toContain(SENTINEL_PREFIX);
  });

  it("result.content 配列内の object に text が無い場合は JSON 化 byte 数で計算", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("tool_result_persist")!;
    const result = handler(
      {
        toolId: "read",
        toolCallId: "tcid_arr2",
        result: { content: [{ blob: "x".repeat(100_000) }] },
      },
      {},
    ) as ToolResultPersistResult;
    expect((result as any).message).toBeDefined();
  });

  it("result.content 配列内の非 object 要素も byte 数で計算", () => {
    const api = makeApi({ rewriteThresholdBytes: 100 });
    register(api as any);
    const handler = api.hooks.get("tool_result_persist")!;
    const result = handler(
      {
        toolId: "read",
        toolCallId: "tcid_arr3",
        result: { content: ["text".repeat(50), 12345, true] },
      },
      {},
    ) as ToolResultPersistResult;
    expect((result as any).message).toBeDefined();
  });

  it("result が undefined / null の場合は 0 byte 扱いで置換しない", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("tool_result_persist")!;
    const result1 = handler({ toolId: "read", toolCallId: "n1", result: null }, {});
    const result2 = handler({ toolId: "read", toolCallId: "n2", result: undefined }, {});
    expect(result1).toEqual({});
    expect(result2).toEqual({});
  });

  it("result が plain object（content なし）の場合は JSON 化 byte 数で計算", () => {
    const api = makeApi({ rewriteThresholdBytes: 50 });
    register(api as any);
    const handler = api.hooks.get("tool_result_persist")!;
    const result = handler(
      {
        toolId: "read",
        toolCallId: "tcid_plain",
        result: { other: "x".repeat(200) },
      },
      {},
    ) as ToolResultPersistResult;
    expect((result as any).message).toBeDefined();
  });
});

describe("verbose mode（safePreview / truncateUtf8）", () => {
  it("verbose=true で tool params の概略を log に含める", () => {
    const api = makeApi({ verbose: true });
    register(api as any);
    const handler = api.hooks.get("before_tool_call")!;
    api.logger.info.mockClear();
    handler({ toolId: "read", params: { path: "/data/workspace/note.md" } }, {});
    const infoCalls = api.logger.info.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(infoCalls.some((m) => m.includes("params_head="))).toBe(true);
  });

  it("verbose=true で巨大 params を 200 byte で切り詰める", () => {
    const api = makeApi({ verbose: true });
    register(api as any);
    const handler = api.hooks.get("before_tool_call")!;
    api.logger.info.mockClear();
    handler({ toolId: "read", params: { content: "x".repeat(1000) } }, {});
    const infoCalls = api.logger.info.mock.calls.map((c: unknown[]) => c[0] as string);
    const headLog = infoCalls.find((m) => m.includes("params_head="));
    expect(headLog).toBeDefined();
    expect(headLog!.length).toBeLessThan(500);
  });

  it("verbose=true で undefined params も `(empty)` で扱う", () => {
    const api = makeApi({ verbose: true });
    register(api as any);
    const handler = api.hooks.get("before_tool_call")!;
    api.logger.info.mockClear();
    handler({ toolId: "read", params: undefined }, {});
    const infoCalls = api.logger.info.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(infoCalls.some((m) => m.includes('params_head="(empty)"'))).toBe(true);
  });

  it("logging=false のときは log を出さない", () => {
    const api = makeApi({ logging: false });
    register(api as any);
    const handler = api.hooks.get("before_tool_call")!;
    api.logger.info.mockClear();
    handler({ toolId: "read", params: { path: "/data/workspace/note.md" } }, {});
    // registered log は出たが、handler 内の log は出ない
    const handlerLogs = api.logger.info.mock.calls.filter((c: unknown[]) =>
      (c[0] as string).includes("before_tool_call"),
    );
    expect(handlerLogs).toHaveLength(0);
  });
});

describe("config 解決ロジック", () => {
  it("不正な blockMode 値は既定の `block` にフォールバック", () => {
    const api = makeApi({ blockMode: "invalid" as any });
    register(api as any);
    const registerLog = api.logger.info.mock.calls[0][0] as string;
    expect(registerLog).toContain("blockMode=block");
  });

  it("負の rewriteThresholdBytes は既定値にフォールバック", () => {
    const api = makeApi({ rewriteThresholdBytes: -100 });
    register(api as any);
    const registerLog = api.logger.info.mock.calls[0][0] as string;
    expect(registerLog).toContain("rewrite=50000b");
  });

  it("非 array の denyPaths は既定値にフォールバック", () => {
    const api = makeApi({ denyPaths: "not-array" as any });
    register(api as any);
    const registerLog = api.logger.info.mock.calls[0][0] as string;
    expect(registerLog).toContain("/data/workspace/zoom_transcribe");
  });

  it("null pluginConfig も既定値で起動", () => {
    const api = makeApi();
    (api as any).pluginConfig = undefined;
    expect(() => register(api as any)).not.toThrow();
  });
});

describe("session state 累積（cumulative budget tracking）", () => {
  it("同一 session で max(累積) を保持（後続呼び出しで小さい messages でも budget 超過状態を維持）", () => {
    const api = makeApi({ perTurnPromptInputThreshold: 10_000_000 });
    register(api as any);
    const handler = api.hooks.get("before_agent_run")!;
    // 第 1 turn: messages が budget を超える
    handler(
      {
        sessionId: "session_sticky",
        prompt: "",
        messages: [{ role: "user", content: "x".repeat(2_500_000) }],
      },
      {},
    );
    // 第 2 turn: messages を小さくしても session 状態は維持される
    const result = handler(
      {
        sessionId: "session_sticky",
        prompt: "",
        messages: [{ role: "user", content: "small" }],
      },
      {},
    ) as BeforeAgentRunResult;
    expect(result.outcome).toBe("block");
    expect((result as any).reason).toBe("session_token_budget_exceeded");
  });

  it("別 session ID は累積を共有しない", () => {
    const api = makeApi({ perTurnPromptInputThreshold: 10_000_000 });
    register(api as any);
    const handler = api.hooks.get("before_agent_run")!;
    handler(
      {
        sessionId: "session_A",
        prompt: "",
        messages: [{ role: "user", content: "x".repeat(2_500_000) }],
      },
      {},
    );
    const result = handler(
      {
        sessionId: "session_B",
        prompt: "",
        messages: [{ role: "user", content: "small" }],
      },
      {},
    ) as BeforeAgentRunResult;
    expect(result.outcome).toBe("pass");
  });

  it("sessionId 未指定時は channelId / accountId / 'default' に fallback", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("before_agent_run")!;
    const result1 = handler({ channelId: "C1", prompt: "", messages: [] }, {});
    const result2 = handler({ accountId: "U1", prompt: "", messages: [] }, {});
    const result3 = handler({ prompt: "", messages: [] }, {});
    expect((result1 as BeforeAgentRunResult).outcome).toBe("pass");
    expect((result2 as BeforeAgentRunResult).outcome).toBe("pass");
    expect((result3 as BeforeAgentRunResult).outcome).toBe("pass");
  });
});

describe("before_tool_call - block reason variants", () => {
  it("toolId 未指定時は (unknown) で表示", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("before_tool_call")!;
    const result = handler({ params: { path: `${DENY}x.txt` } }, {}) as BeforeToolCallResult;
    expect((result as any).block).toBe(true);
  });

  it("toolName のみ指定（toolId なし）でも動作", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("before_tool_call")!;
    const result = handler(
      { toolName: "read", params: { path: `${DENY}x.txt` } },
      {},
    ) as BeforeToolCallResult;
    expect((result as any).block).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// before_agent_run: suspendAgent / 段 1 per-turn / 段 2 session / cleanup
// ----------------------------------------------------------------------------

describe("before_agent_run - suspendAgent (rollback Mode A)", () => {
  it("suspendAgent=true で agent run 自体を block", () => {
    const api = makeApi({ suspendAgent: true });
    register(api as any);
    const handler = api.hooks.get("before_agent_run")!;
    const result = handler(
      { sessionId: "s1", prompt: "hi", messages: [] },
      {},
    ) as BeforeAgentRunResult;
    expect(result.outcome).toBe("block");
    expect((result as any).reason).toBe("agent_suspended");
  });

  it("suspendAgent=false（既定）では block しない", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("before_agent_run")!;
    const result = handler(
      { sessionId: "s2", prompt: "hi", messages: [] },
      {},
    ) as BeforeAgentRunResult;
    expect(result.outcome).toBe("pass");
  });
});

describe("before_agent_run - 段 1 per-turn input gate", () => {
  it("perTurnPromptInputThreshold 未満（49,999 token）は pass", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("before_agent_run")!;
    const prompt = "x".repeat(199_996); // 49,999 tokens
    const result = handler({ sessionId: "s1", prompt, messages: [] }, {}) as BeforeAgentRunResult;
    expect(result.outcome).toBe("pass");
  });

  it("perTurnPromptInputThreshold ちょうど（50,000 token）は pass（境界は超過ではない）", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("before_agent_run")!;
    const prompt = "x".repeat(200_000); // 50,000 tokens
    const result = handler({ sessionId: "s1", prompt, messages: [] }, {}) as BeforeAgentRunResult;
    expect(result.outcome).toBe("pass");
  });

  it("perTurnPromptInputThreshold 超過（50,001 token）は block", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("before_agent_run")!;
    const prompt = "x".repeat(200_004); // 50,001 tokens
    const result = handler({ sessionId: "s1", prompt, messages: [] }, {}) as BeforeAgentRunResult;
    expect(result.outcome).toBe("block");
    expect((result as any).reason).toBe("per_turn_input_too_large");
    expect((result as any).message).toContain("入力サイズ");
  });

  it("block 時に metric `cost_guard.per_turn_input_blocked` を発行", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("before_agent_run")!;
    handler({ sessionId: "s1", prompt: "x".repeat(300_000), messages: [] }, {});
    expect(api.metrics.incrementCounter).toHaveBeenCalledWith(
      "cost_guard.per_turn_input_blocked",
      expect.anything(),
    );
  });

  it("blockMode=observe では per-turn gate でも block しない", () => {
    const api = makeApi({ blockMode: "observe" });
    register(api as any);
    const handler = api.hooks.get("before_agent_run")!;
    const result = handler(
      { sessionId: "s1", prompt: "x".repeat(300_000), messages: [] },
      {},
    ) as BeforeAgentRunResult;
    expect(result.outcome).toBe("pass");
  });
});

describe("before_agent_run - 段 2 session token budget", () => {
  it("sessionTokenBudget 未満（499,994 token）は pass", () => {
    // 段 2 単独を検証するため per-turn gate を緩める（大きい messages は per-turn gate を必ず超える）
    const api = makeApi({ perTurnPromptInputThreshold: 10_000_000 });
    register(api as any);
    const handler = api.hooks.get("before_agent_run")!;
    // user(1) + content(499_988) + tool_call_id(0) + overhead(4) = 499_993 token < 500_000 budget
    const messages = [{ role: "user" as const, content: "x".repeat(1_999_952) }];
    const result = handler({ sessionId: "s1", prompt: "", messages }, {}) as BeforeAgentRunResult;
    expect(result.outcome).toBe("pass");
  });

  it("sessionTokenBudget 超過は session_token_budget_exceeded で block", () => {
    const api = makeApi({ perTurnPromptInputThreshold: 10_000_000 }); // per-turn gate を緩めて段 2 を確認
    register(api as any);
    const handler = api.hooks.get("before_agent_run")!;
    const messages = [{ role: "user" as const, content: "x".repeat(2_005_000) }]; // > 500_000 tokens
    const result = handler({ sessionId: "s1", prompt: "", messages }, {}) as BeforeAgentRunResult;
    expect(result.outcome).toBe("block");
    expect((result as any).reason).toBe("session_token_budget_exceeded");
  });

  it("block 時に metric `cost_guard.session_budget_exceeded` を発行", () => {
    const api = makeApi({ perTurnPromptInputThreshold: 10_000_000 });
    register(api as any);
    const handler = api.hooks.get("before_agent_run")!;
    handler(
      { sessionId: "s1", prompt: "", messages: [{ role: "user", content: "x".repeat(2_500_000) }] },
      {},
    );
    expect(api.metrics.incrementCounter).toHaveBeenCalledWith(
      "cost_guard.session_budget_exceeded",
      expect.anything(),
    );
  });
});

describe("before_agent_run - cleanup (transcript_pollution_cleanup)", () => {
  it("cleanupOnSessionStart=true で過去 messages の denyPaths 参照を sentinel 置換", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("before_agent_run")!;
    const messages = [
      { role: "user" as const, content: "please read" },
      {
        role: "tool" as const,
        content: `Here is content from ${DENY}transcript.txt\n... raw transcript body ...`,
        tool_call_id: "tcid_p1",
      },
    ];
    const result = handler(
      { sessionId: "s1", prompt: "next turn", messages },
      {},
    ) as BeforeAgentRunResult;
    expect(result.outcome).toBe("rewrite");
    expect((result as any).reason).toBe("transcript_pollution_cleanup");
    expect((result as any).messages[1].content).toContain(SENTINEL_PREFIX);
    expect((result as any).messages[1].role).toBe("tool");
    expect((result as any).messages[1].tool_call_id).toBe("tcid_p1");
  });

  it("cleanupOnSessionStart=false では rewrite しない", () => {
    const api = makeApi({ cleanupOnSessionStart: false });
    register(api as any);
    const handler = api.hooks.get("before_agent_run")!;
    const messages = [{ role: "tool" as const, content: `${DENY}x.txt`, tool_call_id: "tcid_x" }];
    const result = handler(
      { sessionId: "s1", prompt: "next", messages },
      {},
    ) as BeforeAgentRunResult;
    expect(result.outcome).toBe("pass");
  });

  it("既に sentinel 化されている message は再置換しない", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("before_agent_run")!;
    const messages = [
      {
        role: "tool" as const,
        content: `${SENTINEL_PREFIX} (50001 bytes). Use analyze_transcript or specific tool to access content.`,
        tool_call_id: "tcid_already",
      },
    ];
    const result = handler(
      { sessionId: "s1", prompt: "next", messages },
      {},
    ) as BeforeAgentRunResult;
    // sentinel は denyPaths を含まないので rewrite しない（pass）
    expect(result.outcome).toBe("pass");
  });

  it("非 tool role の message は cleanup 対象外", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("before_agent_run")!;
    const messages = [
      { role: "user" as const, content: `please read ${DENY}x.txt` },
      { role: "assistant" as const, content: "ok" },
    ];
    const result = handler(
      { sessionId: "s1", prompt: "next", messages },
      {},
    ) as BeforeAgentRunResult;
    expect(result.outcome).toBe("pass");
  });

  it("cleanup 時に metric `cost_guard.transcript_pollution_detected` を発行", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("before_agent_run")!;
    const messages = [
      { role: "tool" as const, content: `${DENY}x.txt content`, tool_call_id: "tcid_m" },
    ];
    handler({ sessionId: "s1", prompt: "next", messages }, {});
    expect(api.metrics.incrementCounter).toHaveBeenCalledWith(
      "cost_guard.transcript_pollution_detected",
      expect.anything(),
    );
  });
});

// ----------------------------------------------------------------------------
// metric 発行の総合確認
// ----------------------------------------------------------------------------

describe("metric 発行（contracts.md §10.1 の 5 metric）", () => {
  it("`cost_guard.tool_call_blocked` を発行", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("before_tool_call")!;
    handler({ toolId: "read", params: { path: `${DENY}x.txt` } }, {});
    expect(api.metrics.incrementCounter).toHaveBeenCalledWith(
      "cost_guard.tool_call_blocked",
      expect.anything(),
    );
  });

  it("`cost_guard.tool_result_rewritten` を発行", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("tool_result_persist")!;
    handler({ toolId: "read", toolCallId: "tcid_a", result: { content: "x".repeat(60_000) } }, {});
    expect(api.metrics.incrementCounter).toHaveBeenCalledWith(
      "cost_guard.tool_result_rewritten",
      expect.anything(),
    );
  });

  it("`cost_guard.per_turn_input_blocked` を発行", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("before_agent_run")!;
    handler({ sessionId: "s1", prompt: "x".repeat(300_000), messages: [] }, {});
    expect(api.metrics.incrementCounter).toHaveBeenCalledWith(
      "cost_guard.per_turn_input_blocked",
      expect.anything(),
    );
  });

  it("`cost_guard.session_budget_exceeded` を発行", () => {
    const api = makeApi({ perTurnPromptInputThreshold: 10_000_000 });
    register(api as any);
    const handler = api.hooks.get("before_agent_run")!;
    handler(
      { sessionId: "s1", prompt: "", messages: [{ role: "user", content: "x".repeat(2_500_000) }] },
      {},
    );
    expect(api.metrics.incrementCounter).toHaveBeenCalledWith(
      "cost_guard.session_budget_exceeded",
      expect.anything(),
    );
  });

  it("`cost_guard.transcript_pollution_detected` を発行", () => {
    const api = makeApi();
    register(api as any);
    const handler = api.hooks.get("before_agent_run")!;
    handler(
      {
        sessionId: "s1",
        prompt: "next",
        messages: [{ role: "tool", content: `${DENY}x.txt content`, tool_call_id: "tcid_p" }],
      },
      {},
    );
    expect(api.metrics.incrementCounter).toHaveBeenCalledWith(
      "cost_guard.transcript_pollution_detected",
      expect.anything(),
    );
  });

  it("metrics API 未提供（OpenClaw 古いバージョン）でも throw しない", () => {
    const api = makeApi();
    (api as any).metrics = undefined;
    expect(() => register(api as any)).not.toThrow();
    const handler = api.hooks.get("before_tool_call")!;
    expect(() => handler({ toolId: "read", params: { path: `${DENY}x.txt` } }, {})).not.toThrow();
  });
});

// ----------------------------------------------------------------------------
// npm package metadata
// ----------------------------------------------------------------------------

describe("npm package metadata", () => {
  it("openclaw.plugin.json の id が cost-guard", () => {
    const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const pluginJson = JSON.parse(
      readFileSync(resolve(packageDir, "openclaw.plugin.json"), "utf8"),
    ) as { id: string; configSchema: { properties: Record<string, unknown> } };
    expect(pluginJson.id).toBe("cost-guard");
  });

  it("configSchema が contracts.md §9.1 の全 11 property を持つ", () => {
    const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const pluginJson = JSON.parse(
      readFileSync(resolve(packageDir, "openclaw.plugin.json"), "utf8"),
    ) as { configSchema: { properties: Record<string, unknown> } };
    const props = Object.keys(pluginJson.configSchema.properties);
    for (const required of [
      "logging",
      "verbose",
      "blockMode",
      "denyPaths",
      "allowlistedToolsForDenyPaths",
      "rewriteThresholdBytes",
      "sessionTokenBudget",
      "perTurnPromptInputThreshold",
      "commandDenylist",
      "denyHardlinkTraversal",
      "cleanupOnSessionStart",
      "suspendAgent",
    ]) {
      expect(props).toContain(required);
    }
  });

  it("blockMode のデフォルトが `block`（Phase 1 本番既定）", () => {
    const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const pluginJson = JSON.parse(
      readFileSync(resolve(packageDir, "openclaw.plugin.json"), "utf8"),
    ) as {
      configSchema: {
        properties: { blockMode: { default: string; enum: string[] } };
      };
    };
    expect(pluginJson.configSchema.properties.blockMode.default).toBe("block");
    expect(pluginJson.configSchema.properties.blockMode.enum).toEqual(["observe", "block"]);
  });

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
    const [pack] = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
    const files = new Set(pack.files.map((file) => file.path));
    expect(files.has("package.json")).toBe(true);
    for (const extension of packageJson.openclaw.extensions) {
      expect(files.has(extension.replace(/^\.\//, ""))).toBe(true);
    }
  });
});
