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
import { type SessionMessage } from "./token-estimator.js";
export type BlockReason = "deny_path_match" | "deny_path_match_inode" | "deny_path_match_symlink" | "command_denylist_match" | "tool_not_in_allowlist";
export type BeforeToolCallResult = Record<string, never> | {
    block: true;
    blockReason: BlockReason;
    message?: string;
} | {
    requireApproval: {
        approverRole: string;
        message: string;
    };
};
export interface ToolResultMessage {
    role: "tool";
    tool_call_id: string;
    content: string;
}
export type ToolResultPersistResult = Record<string, never> | {
    message: ToolResultMessage;
};
export type BeforeAgentRunBlockReason = "per_turn_input_too_large" | "session_token_budget_exceeded";
export type BeforeAgentRunResult = {
    outcome: "pass";
} | {
    outcome: "block";
    reason: BeforeAgentRunBlockReason | "agent_suspended";
    message: string;
} | {
    outcome: "rewrite";
    messages: SessionMessage[];
    reason: "transcript_pollution_cleanup";
};
export { SENTINEL_PREFIX } from "./sentinel.js";
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
export default function register(api: OpenClawPluginApi): void;
//# sourceMappingURL=index.d.ts.map