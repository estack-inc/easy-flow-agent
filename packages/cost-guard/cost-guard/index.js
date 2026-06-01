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
import { estimateMessagesTokenCount, estimatePromptInputTokens, estimateTokenCount, } from "./token-estimator.js";
const TAG = "[cost-guard]";
const VERBOSE_PARAM_HEAD_BYTES = 200;
export { SENTINEL_PREFIX } from "./sentinel.js";
// ============================================================================
// 既定値（contracts.md §9.1）
// ============================================================================
const DEFAULTS = {
    logging: true,
    verbose: false,
    blockMode: "block",
    denyPaths: ["/data/workspace/zoom_transcribe/"],
    allowlistedToolsForDenyPaths: [
        "transcript_analyzer_list_transcripts",
        "transcript_analyzer_search_transcripts",
        "transcript_analyzer_analyze_transcript",
    ],
    rewriteThresholdBytes: 50000,
    sessionTokenBudget: 500000,
    perTurnPromptInputThreshold: 50000,
    commandDenylist: ["eval", "bash -c $", "sh -c $", "<(", "$(", "`"],
    denyHardlinkTraversal: true,
    cleanupOnSessionStart: true,
    suspendAgent: false,
};
const BLOCK_MESSAGES = {
    deny_path_match: "/data/workspace/zoom_transcribe/ 配下は専用 tool 経由でのみアクセスできます。transcript-analyzer.* を使ってください。",
    deny_path_match_inode: "/data/workspace/zoom_transcribe/ 配下は専用 tool 経由でのみアクセスできます。transcript-analyzer.* を使ってください。",
    deny_path_match_symlink: "/data/workspace/zoom_transcribe/ 配下は専用 tool 経由でのみアクセスできます。transcript-analyzer.* を使ってください。",
    command_denylist_match: "この command パターンは禁止されています。",
    tool_not_in_allowlist: "この path は専用 tool 経由のみアクセス可能です。",
};
const PER_TURN_BLOCK_MESSAGE = "次ターンの入力サイズが大きすぎるため処理できません。session を /reset するか、長いコンテキストを分割してください。";
const SESSION_BUDGET_BLOCK_MESSAGE = "このセッションのトークン上限を超えたため新規メッセージを受け付けません。/reset で新規開始してください。";
const SUSPENDED_BLOCK_MESSAGE = "cost-guard suspendAgent=true により agent 実行を一時停止しています。運用者に確認してください。";
// ============================================================================
// register（OpenClaw plugin entry point）
// ============================================================================
export default function register(api) {
    const cfg = resolveConfig((api.pluginConfig ?? {}));
    const log = api.logger;
    const warn = (message) => {
        if (log.warn)
            log.warn(message);
        else
            log.info(message);
    };
    const metrics = api.metrics;
    const incCounter = (name, labels) => {
        metrics?.incrementCounter?.(name, labels);
    };
    // session 単位の cumulative token tracking（プロセス内 in-memory map）
    const sessionStateMap = new Map();
    log.info(`${TAG} registered (blockMode=${cfg.blockMode}, denyPaths=${JSON.stringify(cfg.denyPaths)}, ` +
        `allowlist=${cfg.allowlistedToolsForDenyPaths.length}, rewrite=${cfg.rewriteThresholdBytes}b, ` +
        `perTurnGate=${cfg.perTurnPromptInputThreshold}, sessionBudget=${cfg.sessionTokenBudget}, ` +
        `denyHardlinkTraversal=${cfg.denyHardlinkTraversal}, suspendAgent=${cfg.suspendAgent})`);
    // --------------------------------------------------------------------------
    // before_tool_call: denyPaths block + allowlist + commandDenylist
    // --------------------------------------------------------------------------
    api.on("before_tool_call", (event, _ctx) => {
        const e = event;
        const toolId = e.toolId ?? e.toolName ?? "(unknown)";
        // 1. commandDenylist 検査（command-like field のみ）
        const commandMatch = findCommandDenylistMatch(e.params, {
            commandDenylist: cfg.commandDenylist,
        });
        if (commandMatch) {
            const result = {
                block: true,
                blockReason: "command_denylist_match",
                message: BLOCK_MESSAGES.command_denylist_match,
            };
            logBlock(warn, cfg, toolId, "command_denylist_match", commandMatch.matchedPattern, commandMatch.field);
            incCounter("cost_guard.tool_call_blocked", {
                blockReason: "command_denylist_match",
                toolId,
            });
            if (cfg.blockMode === "observe")
                return {};
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
                    log.info(`${TAG} allowlisted: tool=${toolId} matched_path="${pathMatch.matched}" field="${pathMatch.field}" reason=${pathMatch.reason}`);
                }
                return {};
            }
            const blockReason = pathMatch.reason;
            const result = {
                block: true,
                blockReason,
                message: BLOCK_MESSAGES[blockReason],
            };
            logBlock(warn, cfg, toolId, blockReason, pathMatch.matched, pathMatch.field);
            incCounter("cost_guard.tool_call_blocked", { blockReason, toolId });
            if (cfg.blockMode === "observe")
                return {};
            return result;
        }
        // 観測 log（block されなかった場合）
        if (cfg.logging) {
            if (cfg.verbose) {
                const paramsPreview = safePreview(e.params, VERBOSE_PARAM_HEAD_BYTES);
                log.info(`${TAG} before_tool_call: tool=${toolId} params_head="${paramsPreview}"`);
            }
            else {
                log.info(`${TAG} before_tool_call: tool=${toolId}`);
            }
        }
        return {};
    });
    // --------------------------------------------------------------------------
    // tool_result_persist: rewriteThresholdBytes 超で sentinel 置換
    // --------------------------------------------------------------------------
    api.on("tool_result_persist", (event, _ctx) => {
        // OpenClaw の tool_result_persist event は tool result を `message`(AgentMessage) に格納する。
        // `result` フィールドは存在しない（hook-types.d.ts: PluginHookToolResultPersistEvent）。
        const e = event;
        const toolId = e.toolName ?? "(unknown)";
        const toolCallId = e.message?.tool_call_id ?? e.toolCallId ?? "";
        const contentBytes = extractResultContentBytes(e.message);
        if (cfg.logging) {
            log.info(`${TAG} tool_result_persist: tool=${toolId} call_id=${toolCallId || "(none)"} bytes=${contentBytes}`);
        }
        if (contentBytes > cfg.rewriteThresholdBytes) {
            const sentinel = buildSentinelMessage(contentBytes);
            // observe では実際の rewrite を行わないため、log 文言で観測モードを明示する
            const action = cfg.blockMode === "observe" ? "tool_result_would_be_rewritten" : "tool_result_rewritten";
            log.info(`${TAG} ${action}: tool=${toolId} call_id=${toolCallId} bytes=${contentBytes} threshold=${cfg.rewriteThresholdBytes}`);
            incCounter("cost_guard.tool_result_rewritten", { toolId });
            if (cfg.blockMode === "observe")
                return {};
            return {
                message: {
                    ...e.message,
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
    api.on("before_agent_run", (event, ctx) => {
        const e = event;
        // session 識別子は ctx(PluginHookAgentContext) が正本（OpenClaw 実 event には sessionId が無い）。
        // e.sessionId は後方互換 fallback（ctx より低優先。host 差異や旧 event 形式への保険）。
        const c = ctx;
        const sessionId = c.sessionId ?? c.sessionKey ?? e.sessionId ?? e.channelId ?? e.accountId ?? "default";
        // 0. rollback Mode A: suspendAgent
        //    本 case は contracts.md §10.1 の 5 metric とは独立した運用イベントのため、
        //    `cost_guard.session_budget_exceeded` には混ぜず、専用 metric を別途発行する。
        if (cfg.suspendAgent) {
            warn(`${TAG} agent_suspended: session=${sessionId} (suspendAgent=true)`);
            incCounter("cost_guard.agent_suspended_block", { sessionId });
            if (cfg.blockMode === "observe")
                return { outcome: "pass" };
            return {
                outcome: "block",
                reason: "agent_suspended",
                message: SUSPENDED_BLOCK_MESSAGE,
            };
        }
        // 1. 段 1: per-turn prompt input gate
        const perTurnTokens = estimatePromptInputTokens(e.prompt, e.messages);
        if (perTurnTokens > cfg.perTurnPromptInputThreshold) {
            warn(`${TAG} per_turn_input_too_large: session=${sessionId} estimated_tokens=${perTurnTokens} threshold=${cfg.perTurnPromptInputThreshold}`);
            incCounter("cost_guard.per_turn_input_blocked", { sessionId });
            if (cfg.blockMode === "observe") {
                // observe では block しないが log は出す
            }
            else {
                return {
                    outcome: "block",
                    reason: "per_turn_input_too_large",
                    message: PER_TURN_BLOCK_MESSAGE,
                };
            }
        }
        // 2. 段 2: session cumulative breaker
        const sessionState = getOrCreateSessionState(sessionStateMap, sessionId);
        const sessionUpdate = updateSessionBudgetState(sessionState, e.prompt, e.messages);
        if (sessionUpdate.cumulativeTokens > cfg.sessionTokenBudget) {
            warn(`${TAG} session_token_budget_exceeded: session=${sessionId} cumulative_tokens=${sessionUpdate.cumulativeTokens} budget=${cfg.sessionTokenBudget}`);
            incCounter("cost_guard.session_budget_exceeded", { sessionId });
            if (cfg.blockMode === "observe") {
                // observe では block しないが log は出す
            }
            else {
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
                log.info(`${TAG} transcript_pollution_detected: session=${sessionId} rewritten=${cleanupResult.rewrittenCount}`);
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
            log.info(`${TAG} before_agent_run: session=${sessionId} prompt_len=${promptLen} messages=${msgCount} ` +
                `per_turn_tokens=${perTurnTokens} session_tokens=${sessionUpdate.cumulativeTokens}`);
        }
        return { outcome: "pass" };
    });
}
function resolveConfig(raw) {
    const blockMode = raw.blockMode === "observe" || raw.blockMode === "block" ? raw.blockMode : DEFAULTS.blockMode;
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
        rewriteThresholdBytes: typeof raw.rewriteThresholdBytes === "number" && raw.rewriteThresholdBytes >= 0
            ? raw.rewriteThresholdBytes
            : DEFAULTS.rewriteThresholdBytes,
        sessionTokenBudget: typeof raw.sessionTokenBudget === "number" && raw.sessionTokenBudget >= 0
            ? raw.sessionTokenBudget
            : DEFAULTS.sessionTokenBudget,
        perTurnPromptInputThreshold: typeof raw.perTurnPromptInputThreshold === "number" && raw.perTurnPromptInputThreshold >= 0
            ? raw.perTurnPromptInputThreshold
            : DEFAULTS.perTurnPromptInputThreshold,
        commandDenylist: Array.isArray(raw.commandDenylist)
            ? raw.commandDenylist.filter((s) => typeof s === "string" && s.length > 0)
            : DEFAULTS.commandDenylist.slice(),
        denyHardlinkTraversal: typeof raw.denyHardlinkTraversal === "boolean"
            ? raw.denyHardlinkTraversal
            : DEFAULTS.denyHardlinkTraversal,
        cleanupOnSessionStart: typeof raw.cleanupOnSessionStart === "boolean"
            ? raw.cleanupOnSessionStart
            : DEFAULTS.cleanupOnSessionStart,
        suspendAgent: typeof raw.suspendAgent === "boolean" ? raw.suspendAgent : DEFAULTS.suspendAgent,
    };
}
function logBlock(warn, cfg, toolId, blockReason, matched, field) {
    if (!cfg.logging)
        return;
    warn(`${TAG} BLOCKED: tool=${toolId} reason=${blockReason} matched="${matched}" field="${field}" blockMode=${cfg.blockMode}`);
}
function extractResultContentBytes(result) {
    if (result === undefined || result === null)
        return 0;
    if (typeof result === "string")
        return computeContentBytes(result);
    if (typeof result === "object") {
        const r = result;
        if (typeof r.content === "string")
            return computeContentBytes(r.content);
        if (Array.isArray(r.content)) {
            let total = 0;
            for (const item of r.content) {
                total += computeContentBytes(item);
            }
            return total;
        }
        return computeContentBytes(result);
    }
    return computeContentBytes(result);
}
function getOrCreateSessionState(map, sessionId) {
    let s = map.get(sessionId);
    if (!s) {
        s = { cumulativeTokens: 0, observedMessagesTokens: 0 };
        map.set(sessionId, s);
    }
    return s;
}
function updateSessionBudgetState(sessionState, prompt, messages) {
    const promptTokens = estimateTokenCount(prompt ?? "");
    const messagesTokens = estimateMessagesTokenCount(messages);
    const messagesDeltaTokens = Math.max(0, messagesTokens - sessionState.observedMessagesTokens);
    // prompt は current turn 入力として毎回加算し、messages 履歴は前回観測からの増分だけ加算する。
    const turnTokens = promptTokens + messagesDeltaTokens;
    sessionState.cumulativeTokens += turnTokens;
    sessionState.observedMessagesTokens = Math.max(sessionState.observedMessagesTokens, messagesTokens);
    return {
        promptTokens,
        messagesTokens,
        messagesDeltaTokens,
        turnTokens,
        cumulativeTokens: sessionState.cumulativeTokens,
    };
}
/**
 * 過去 messages 内の tool result で denyPaths 配下の path 参照を sentinel 置換する。
 * tool role かつ既に sentinel 化されていない message のみが対象。
 */
function cleanupSessionMessages(messages, cfg) {
    let rewrittenCount = 0;
    const denyPaths = cfg.denyPaths;
    const rewritten = messages.map((msg) => {
        if (!msg || typeof msg !== "object")
            return msg;
        if (msg.role !== "tool")
            return msg;
        const content = msg.content ?? "";
        const searchableContent = messageContentToSearchText(content);
        if (searchableContent === "")
            return msg;
        if (isSentinelMessage(searchableContent))
            return msg;
        // denyPaths のいずれかの prefix が含まれているかを単純 contains で判定
        const hit = denyPaths.some((p) => searchableContent.includes(p));
        if (!hit)
            return msg;
        rewrittenCount++;
        return {
            ...msg,
            content: buildSentinelMessage(computeContentBytes(content)),
        };
    });
    return { messages: rewritten, rewrittenCount };
}
function messageContentToSearchText(content) {
    if (typeof content === "string")
        return content;
    if (content === undefined || content === null)
        return "";
    if (Array.isArray(content)) {
        const parts = [];
        for (const item of content) {
            if (typeof item === "string") {
                parts.push(item);
                continue;
            }
            if (item && typeof item === "object") {
                const text = item.text;
                if (typeof text === "string")
                    parts.push(text);
                else
                    parts.push(safeJsonStringify(item));
                continue;
            }
            parts.push(String(item));
        }
        return parts.join("\n");
    }
    if (typeof content === "object")
        return safeJsonStringify(content);
    return String(content);
}
function safeJsonStringify(value) {
    const seen = new WeakSet();
    try {
        return (JSON.stringify(value, (_key, v) => {
            if (typeof v !== "object" || v === null)
                return v;
            if (seen.has(v))
                return "[Circular]";
            seen.add(v);
            return v;
        }) ?? "");
    }
    catch {
        return String(value);
    }
}
function safePreview(v, maxBytes) {
    if (v === undefined || v === null)
        return "(empty)";
    let s;
    try {
        s = typeof v === "string" ? v : JSON.stringify(v);
    }
    catch {
        return "(unserializable)";
    }
    if (typeof s !== "string")
        return "(unserializable)";
    s = s.replace(/\s+/g, " ").trim();
    return truncateUtf8(s, maxBytes);
}
function truncateUtf8(s, maxBytes) {
    if (Buffer.byteLength(s, "utf8") <= maxBytes)
        return s;
    const suffix = "...";
    const suffixBytes = Buffer.byteLength(suffix, "utf8");
    const headLimit = Math.max(0, maxBytes - suffixBytes);
    let head = "";
    let headBytes = 0;
    for (const char of s) {
        const charBytes = Buffer.byteLength(char, "utf8");
        if (headBytes + charBytes > headLimit)
            break;
        head += char;
        headBytes += charBytes;
    }
    return `${head}${suffix}`;
}
