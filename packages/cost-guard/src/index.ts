/**
 * cost-guard: Phase 1 本格版 plugin
 *
 * 目的（hongmong-ochi-agent の transcript コスト爆発 $1990/月への構造対策）：
 * - denyPaths 配下への汎用 file access を default deny で遮断
 * - transcript-analyzer.* の 3 tool のみを allowlist で通す
 * - 50KB 超の tool result を sentinel 置換し prompt cache 注入を防止
 * - per-turn / session 単位の token gate で暴走 prompt を遮断
 *
 * 3 hook：
 * - before_tool_call    : denyPaths 配下への汎用 tool 呼び出しを block（allowlist 例外）
 * - tool_result_persist : rewriteThresholdBytes 超の result を sentinel 置換（tool_call_id 保持）
 * - before_agent_run    : 段 1 per-turn input gate → 段 2 session budget breaker
 *                         → 通過後 cleanupOnSessionStart 時に messages 履歴 sentinel 置換
 *
 * 詳細設計：design v6（estack-inc/easy-flow#398 マージ済）
 * 契約：contracts.md（同 case 配下）
 *
 * 本 plugin は cost-guard-hello の基本骨格を踏襲しつつ：
 * - realpath / inode 一致検査を追加（B-4 漏れパターン対処）
 * - commandDenylist の AST 検査を追加
 * - 3 hook 戻り値を contracts.md §2.1 / §2.2 / §2.3 に厳密準拠
 * - 5 metric（cost_guard.*）を発行
 * - rollback Mode A（suspendAgent）対応
 */

import { findCommandDenylistMatch } from "./command-checker.js";
import { findDenyPathMatch } from "./path-checker.js";
import { buildSentinelMessage, computeContentBytes, isSentinelMessage } from "./sentinel.js";
import {
  estimateMessagesTokenCount,
  estimatePromptInputTokens,
  type SessionMessage,
} from "./token-estimator.js";

const TAG = "[cost-guard]";
const VERBOSE_PARAM_HEAD_BYTES = 200;

// ============================================================================
// 型定義（contracts.md §2.1 / §2.2 / §2.3 準拠）
// ============================================================================

export type BlockReason =
  | "deny_path_match"
  | "deny_path_match_inode"
  | "deny_path_match_symlink"
  | "command_denylist_match"
  | "tool_not_in_allowlist";

export type BeforeToolCallResult =
  | Record<string, never>
  | { block: true; blockReason: BlockReason; message?: string }
  | { requireApproval: { approverRole: string; message: string } };

export interface ToolResultMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

export type ToolResultPersistResult = Record<string, never> | { message: ToolResultMessage };

export type BeforeAgentRunBlockReason =
  | "per_turn_input_too_large"
  | "session_token_budget_exceeded";

export type BeforeAgentRunResult =
  | { outcome: "pass" }
  | { outcome: "block"; reason: BeforeAgentRunBlockReason | "agent_suspended"; message: string }
  | {
      outcome: "rewrite";
      messages: SessionMessage[];
      reason: "transcript_pollution_cleanup";
    };

export { SENTINEL_PREFIX } from "./sentinel.js";

// ============================================================================
// 設定型と OpenClawPluginApi 型
// ============================================================================

interface CostGuardConfig {
  logging?: boolean;
  verbose?: boolean;
  blockMode?: "observe" | "block";
  denyPaths?: string[];
  allowlistedToolsForDenyPaths?: string[];
  rewriteThresholdBytes?: number;
  sessionTokenBudget?: number;
  perTurnPromptInputThreshold?: number;
  commandDenylist?: string[];
  denyHardlinkTraversal?: boolean;
  cleanupOnSessionStart?: boolean;
  suspendAgent?: boolean;
}

interface OpenClawLogger {
  info(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}

interface OpenClawMetrics {
  incrementCounter?(name: string, labels?: Record<string, string>): void;
  setGauge?(name: string, value: number, labels?: Record<string, string>): void;
}

export interface OpenClawPluginApi {
  pluginConfig?: Record<string, unknown>;
  logger: OpenClawLogger;
  metrics?: OpenClawMetrics;
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
}

// ============================================================================
// 既定値（contracts.md §9.1）
// ============================================================================

const DEFAULTS = {
  logging: true,
  verbose: false,
  blockMode: "block" as const,
  denyPaths: ["/data/workspace/zoom_transcribe/"],
  allowlistedToolsForDenyPaths: [
    "transcript-analyzer.list_transcripts",
    "transcript-analyzer.search_transcripts",
    "transcript-analyzer.analyze_transcript",
  ],
  rewriteThresholdBytes: 50000,
  sessionTokenBudget: 500000,
  perTurnPromptInputThreshold: 50000,
  commandDenylist: ["eval", "bash -c $", "sh -c $", "<(", "$(", "`"],
  denyHardlinkTraversal: true,
  cleanupOnSessionStart: true,
  suspendAgent: false,
};

const BLOCK_MESSAGES: Record<BlockReason, string> = {
  deny_path_match:
    "/data/workspace/zoom_transcribe/ 配下は専用 tool 経由でのみアクセスできます。transcript-analyzer.* を使ってください。",
  deny_path_match_inode:
    "/data/workspace/zoom_transcribe/ 配下は専用 tool 経由でのみアクセスできます。transcript-analyzer.* を使ってください。",
  deny_path_match_symlink:
    "/data/workspace/zoom_transcribe/ 配下は専用 tool 経由でのみアクセスできます。transcript-analyzer.* を使ってください。",
  command_denylist_match: "この command パターンは禁止されています。",
  tool_not_in_allowlist: "この path は専用 tool 経由のみアクセス可能です。",
};

const PER_TURN_BLOCK_MESSAGE =
  "次ターンの入力サイズが大きすぎるため処理できません。session を /reset するか、長いコンテキストを分割してください。";
const SESSION_BUDGET_BLOCK_MESSAGE =
  "このセッションのトークン上限を超えたため新規メッセージを受け付けません。/reset で新規開始してください。";
const SUSPENDED_BLOCK_MESSAGE =
  "cost-guard suspendAgent=true により agent 実行を一時停止しています。運用者に確認してください。";

// ============================================================================
// session 状態（cumulative token tracking）
// ============================================================================

interface SessionState {
  cumulativeTokens: number;
}

// ============================================================================
// register（OpenClaw plugin entry point）
// ============================================================================

export default function register(api: OpenClawPluginApi): void {
  const cfg = resolveConfig((api.pluginConfig ?? {}) as CostGuardConfig);
  const log = api.logger;
  const warn = (message: string): void => {
    if (log.warn) log.warn(message);
    else log.info(message);
  };
  const metrics = api.metrics;
  const incCounter = (name: string, labels?: Record<string, string>): void => {
    metrics?.incrementCounter?.(name, labels);
  };
  // session 単位の cumulative token tracking（プロセス内 in-memory map）
  const sessionStateMap = new Map<string, SessionState>();

  log.info(
    `${TAG} registered (blockMode=${cfg.blockMode}, denyPaths=${JSON.stringify(cfg.denyPaths)}, ` +
      `allowlist=${cfg.allowlistedToolsForDenyPaths.length}, rewrite=${cfg.rewriteThresholdBytes}b, ` +
      `perTurnGate=${cfg.perTurnPromptInputThreshold}, sessionBudget=${cfg.sessionTokenBudget}, ` +
      `denyHardlinkTraversal=${cfg.denyHardlinkTraversal}, suspendAgent=${cfg.suspendAgent})`,
  );

  // --------------------------------------------------------------------------
  // before_tool_call: denyPaths block + allowlist + commandDenylist
  // --------------------------------------------------------------------------
  api.on("before_tool_call", (event: unknown, _ctx: unknown): BeforeToolCallResult => {
    const e = event as { toolName?: string; toolId?: string; params?: unknown };
    const toolId = e.toolId ?? e.toolName ?? "(unknown)";

    // 1. commandDenylist 検査（command-like field のみ）
    const commandMatch = findCommandDenylistMatch(e.params, {
      commandDenylist: cfg.commandDenylist,
    });
    if (commandMatch) {
      const result: BeforeToolCallResult = {
        block: true,
        blockReason: "command_denylist_match",
        message: BLOCK_MESSAGES.command_denylist_match,
      };
      logBlock(
        warn,
        cfg,
        toolId,
        "command_denylist_match",
        commandMatch.matchedPattern,
        commandMatch.field,
      );
      incCounter("cost_guard.tool_call_blocked", {
        blockReason: "command_denylist_match",
        toolId,
      });
      if (cfg.blockMode === "observe") return {};
      return result;
    }

    // 2. denyPaths 検査
    const pathMatch = findDenyPathMatch(e.params, {
      denyPaths: cfg.denyPaths,
      denyHardlinkTraversal: cfg.denyHardlinkTraversal,
      resolveSymlinks: true,
    });
    if (pathMatch) {
      // 3. allowlist 例外（denyPaths にマッチしても allowlist 内 tool は通過）
      if (cfg.allowlistedToolsForDenyPaths.includes(toolId)) {
        if (cfg.logging) {
          log.info(
            `${TAG} allowlisted: tool=${toolId} matched_path="${pathMatch.matched}" field="${pathMatch.field}" reason=${pathMatch.reason}`,
          );
        }
        return {};
      }
      const blockReason: BlockReason = pathMatch.reason;
      const result: BeforeToolCallResult = {
        block: true,
        blockReason,
        message: BLOCK_MESSAGES[blockReason],
      };
      logBlock(warn, cfg, toolId, blockReason, pathMatch.matched, pathMatch.field);
      incCounter("cost_guard.tool_call_blocked", { blockReason, toolId });
      if (cfg.blockMode === "observe") return {};
      return result;
    }

    // 観測 log（block されなかった場合）
    if (cfg.logging) {
      if (cfg.verbose) {
        const paramsPreview = safePreview(e.params, VERBOSE_PARAM_HEAD_BYTES);
        log.info(`${TAG} before_tool_call: tool=${toolId} params_head="${paramsPreview}"`);
      } else {
        log.info(`${TAG} before_tool_call: tool=${toolId}`);
      }
    }
    return {};
  });

  // --------------------------------------------------------------------------
  // tool_result_persist: rewriteThresholdBytes 超で sentinel 置換
  // --------------------------------------------------------------------------
  api.on("tool_result_persist", (event: unknown, _ctx: unknown): ToolResultPersistResult => {
    const e = event as {
      toolName?: string;
      toolId?: string;
      toolCallId?: string;
      result?: unknown;
    };
    const toolId = e.toolId ?? e.toolName ?? "(unknown)";
    const toolCallId = e.toolCallId ?? "";
    const contentBytes = extractResultContentBytes(e.result);

    if (cfg.logging) {
      log.info(
        `${TAG} tool_result_persist: tool=${toolId} call_id=${toolCallId || "(none)"} bytes=${contentBytes}`,
      );
    }

    if (contentBytes > cfg.rewriteThresholdBytes) {
      const sentinel = buildSentinelMessage(contentBytes);
      log.info(
        `${TAG} tool_result_rewritten: tool=${toolId} call_id=${toolCallId} bytes=${contentBytes} threshold=${cfg.rewriteThresholdBytes}`,
      );
      incCounter("cost_guard.tool_result_rewritten", { toolId });
      if (cfg.blockMode === "observe") return {};
      return {
        message: {
          role: "tool",
          tool_call_id: toolCallId,
          content: sentinel,
        },
      };
    }
    return {};
  });

  // --------------------------------------------------------------------------
  // before_agent_run: 段 1 per-turn gate → 段 2 session budget → cleanup
  // --------------------------------------------------------------------------
  api.on("before_agent_run", (event: unknown, _ctx: unknown): BeforeAgentRunResult => {
    const e = event as {
      prompt?: string;
      messages?: SessionMessage[];
      sessionId?: string;
      accountId?: string;
      channelId?: string;
    };
    const sessionId = e.sessionId ?? e.channelId ?? e.accountId ?? "default";

    // 0. rollback Mode A: suspendAgent
    if (cfg.suspendAgent) {
      warn(`${TAG} agent_suspended: session=${sessionId} (suspendAgent=true)`);
      incCounter("cost_guard.session_budget_exceeded", { reason: "agent_suspended" });
      if (cfg.blockMode === "observe") return { outcome: "pass" };
      return {
        outcome: "block",
        reason: "agent_suspended",
        message: SUSPENDED_BLOCK_MESSAGE,
      };
    }

    // 1. 段 1: per-turn prompt input gate
    const perTurnTokens = estimatePromptInputTokens(e.prompt, e.messages);
    if (perTurnTokens > cfg.perTurnPromptInputThreshold) {
      warn(
        `${TAG} per_turn_input_too_large: session=${sessionId} estimated_tokens=${perTurnTokens} threshold=${cfg.perTurnPromptInputThreshold}`,
      );
      incCounter("cost_guard.per_turn_input_blocked", { sessionId });
      if (cfg.blockMode === "observe") {
        // observe では block しないが log は出す
      } else {
        return {
          outcome: "block",
          reason: "per_turn_input_too_large",
          message: PER_TURN_BLOCK_MESSAGE,
        };
      }
    }

    // 2. 段 2: session cumulative breaker
    const sessionState = getOrCreateSessionState(sessionStateMap, sessionId);
    // cumulative の更新は messages から推定（current turn の messages 全合計を累積扱い）
    const cumulativeTokens = estimateMessagesTokenCount(e.messages);
    sessionState.cumulativeTokens = Math.max(sessionState.cumulativeTokens, cumulativeTokens);
    if (sessionState.cumulativeTokens > cfg.sessionTokenBudget) {
      warn(
        `${TAG} session_token_budget_exceeded: session=${sessionId} cumulative_tokens=${sessionState.cumulativeTokens} budget=${cfg.sessionTokenBudget}`,
      );
      incCounter("cost_guard.session_budget_exceeded", { sessionId });
      if (cfg.blockMode === "observe") {
        // observe では block しないが log は出す
      } else {
        return {
          outcome: "block",
          reason: "session_token_budget_exceeded",
          message: SESSION_BUDGET_BLOCK_MESSAGE,
        };
      }
    }

    // 3. cleanup: 過去 messages の denyPaths 参照を sentinel 置換
    if (cfg.cleanupOnSessionStart && Array.isArray(e.messages) && e.messages.length > 0) {
      const cleanupResult = cleanupSessionMessages(e.messages, cfg);
      if (cleanupResult.rewrittenCount > 0) {
        log.info(
          `${TAG} transcript_pollution_detected: session=${sessionId} rewritten=${cleanupResult.rewrittenCount}`,
        );
        incCounter("cost_guard.transcript_pollution_detected", {
          sessionId,
          rewritten: String(cleanupResult.rewrittenCount),
        });
        if (cfg.blockMode === "block") {
          return {
            outcome: "rewrite",
            messages: cleanupResult.messages,
            reason: "transcript_pollution_cleanup",
          };
        }
      }
    }

    if (cfg.logging) {
      const promptLen = typeof e.prompt === "string" ? e.prompt.length : 0;
      const msgCount = Array.isArray(e.messages) ? e.messages.length : 0;
      log.info(
        `${TAG} before_agent_run: session=${sessionId} prompt_len=${promptLen} messages=${msgCount} ` +
          `per_turn_tokens=${perTurnTokens} session_tokens=${sessionState.cumulativeTokens}`,
      );
    }
    return { outcome: "pass" };
  });
}

// ============================================================================
// helpers
// ============================================================================

interface ResolvedConfig {
  logging: boolean;
  verbose: boolean;
  blockMode: "observe" | "block";
  denyPaths: string[];
  allowlistedToolsForDenyPaths: string[];
  rewriteThresholdBytes: number;
  sessionTokenBudget: number;
  perTurnPromptInputThreshold: number;
  commandDenylist: string[];
  denyHardlinkTraversal: boolean;
  cleanupOnSessionStart: boolean;
  suspendAgent: boolean;
}

function resolveConfig(raw: CostGuardConfig): ResolvedConfig {
  const blockMode =
    raw.blockMode === "observe" || raw.blockMode === "block" ? raw.blockMode : DEFAULTS.blockMode;
  return {
    logging: typeof raw.logging === "boolean" ? raw.logging : DEFAULTS.logging,
    verbose: typeof raw.verbose === "boolean" ? raw.verbose : DEFAULTS.verbose,
    blockMode,
    denyPaths: Array.isArray(raw.denyPaths)
      ? raw.denyPaths.filter((s) => typeof s === "string" && s.length > 0)
      : DEFAULTS.denyPaths.slice(),
    allowlistedToolsForDenyPaths: Array.isArray(raw.allowlistedToolsForDenyPaths)
      ? raw.allowlistedToolsForDenyPaths.filter((s) => typeof s === "string")
      : DEFAULTS.allowlistedToolsForDenyPaths.slice(),
    rewriteThresholdBytes:
      typeof raw.rewriteThresholdBytes === "number" && raw.rewriteThresholdBytes >= 0
        ? raw.rewriteThresholdBytes
        : DEFAULTS.rewriteThresholdBytes,
    sessionTokenBudget:
      typeof raw.sessionTokenBudget === "number" && raw.sessionTokenBudget >= 0
        ? raw.sessionTokenBudget
        : DEFAULTS.sessionTokenBudget,
    perTurnPromptInputThreshold:
      typeof raw.perTurnPromptInputThreshold === "number" && raw.perTurnPromptInputThreshold >= 0
        ? raw.perTurnPromptInputThreshold
        : DEFAULTS.perTurnPromptInputThreshold,
    commandDenylist: Array.isArray(raw.commandDenylist)
      ? raw.commandDenylist.filter((s) => typeof s === "string" && s.length > 0)
      : DEFAULTS.commandDenylist.slice(),
    denyHardlinkTraversal:
      typeof raw.denyHardlinkTraversal === "boolean"
        ? raw.denyHardlinkTraversal
        : DEFAULTS.denyHardlinkTraversal,
    cleanupOnSessionStart:
      typeof raw.cleanupOnSessionStart === "boolean"
        ? raw.cleanupOnSessionStart
        : DEFAULTS.cleanupOnSessionStart,
    suspendAgent: typeof raw.suspendAgent === "boolean" ? raw.suspendAgent : DEFAULTS.suspendAgent,
  };
}

function logBlock(
  warn: (m: string) => void,
  cfg: ResolvedConfig,
  toolId: string,
  blockReason: string,
  matched: string,
  field: string,
): void {
  if (!cfg.logging) return;
  warn(
    `${TAG} BLOCKED: tool=${toolId} reason=${blockReason} matched="${matched}" field="${field}" blockMode=${cfg.blockMode}`,
  );
}

function extractResultContentBytes(result: unknown): number {
  if (result === undefined || result === null) return 0;
  if (typeof result === "string") return computeContentBytes(result);
  if (typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.content === "string") return computeContentBytes(r.content);
    if (Array.isArray(r.content)) {
      let total = 0;
      for (const item of r.content) {
        if (item && typeof item === "object") {
          const text = (item as Record<string, unknown>).text;
          if (typeof text === "string") total += computeContentBytes(text);
          else total += computeContentBytes(item);
        } else {
          total += computeContentBytes(item);
        }
      }
      return total;
    }
    return computeContentBytes(result);
  }
  return computeContentBytes(result);
}

function getOrCreateSessionState(map: Map<string, SessionState>, sessionId: string): SessionState {
  let s = map.get(sessionId);
  if (!s) {
    s = { cumulativeTokens: 0 };
    map.set(sessionId, s);
  }
  return s;
}

/**
 * 過去 messages 内の tool result で denyPaths 配下の path 参照を sentinel 置換する。
 * tool role かつ既に sentinel 化されていない message のみが対象。
 */
function cleanupSessionMessages(
  messages: SessionMessage[],
  cfg: ResolvedConfig,
): { messages: SessionMessage[]; rewrittenCount: number } {
  let rewrittenCount = 0;
  const denyPaths = cfg.denyPaths;
  const rewritten: SessionMessage[] = messages.map((msg) => {
    if (!msg || typeof msg !== "object") return msg;
    if (msg.role !== "tool") return msg;
    if (isSentinelMessage(msg.content)) return msg;
    const content = msg.content ?? "";
    if (typeof content !== "string") return msg;
    // denyPaths のいずれかの prefix が含まれているかを単純 contains で判定
    const hit = denyPaths.some((p) => content.includes(p));
    if (!hit) return msg;
    rewrittenCount++;
    return {
      ...msg,
      content: buildSentinelMessage(computeContentBytes(content)),
    };
  });
  return { messages: rewritten, rewrittenCount };
}

function safePreview(v: unknown, maxBytes: number): string {
  if (v === undefined || v === null) return "(empty)";
  let s: string;
  try {
    s = typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return "(unserializable)";
  }
  if (typeof s !== "string") return "(unserializable)";
  s = s.replace(/\s+/g, " ").trim();
  return truncateUtf8(s, maxBytes);
}

function truncateUtf8(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  const suffix = "...";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const headLimit = Math.max(0, maxBytes - suffixBytes);
  let head = "";
  let headBytes = 0;
  for (const char of s) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (headBytes + charBytes > headLimit) break;
    head += char;
    headBytes += charBytes;
  }
  return `${head}${suffix}`;
}
