/**
 * cost-guard-hello: Phase 0 実証用 observe-only plugin
 *
 * 目的：
 * - OpenClaw 2026.5.12 の plugin deployment path を実機で検証
 * - before_tool_call / tool_result_persist / before_agent_run の発火順序・タイミングを観測
 * - lossless-claw など bundled plugin との hook 評価順序を実測（Phase 0 実証 A）
 *
 * 動作：
 * - block / rewrite / outcome を変更しない（pure observer）
 * - すべての hook 発火を api.logger.info で記録
 * - verbose=true のとき tool params の冒頭 200 文字を log に含める
 *
 * 詳細は easy-flow/docs/operations/transcript-cost-prevention-phase0.md 参照。
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

interface CostGuardHelloConfig {
  logging?: boolean;
  verbose?: boolean;
}

const TAG = "[cost-guard-hello]";
const VERBOSE_PARAM_HEAD_BYTES = 200;

export default function register(api: OpenClawPluginApi): void {
  const cfg = (api.pluginConfig ?? {}) as CostGuardHelloConfig;
  const logging = cfg.logging ?? true;
  const verbose = cfg.verbose ?? false;
  const log = api.logger;

  log.info(`${TAG} registered (logging=${logging}, verbose=${verbose})`);

  // before_tool_call: tool 実行直前。params 検査・block / requireApproval が可能
  api.on("before_tool_call", (event: unknown, _ctx: unknown) => {
    if (!logging) return {};
    const e = event as { toolName?: string; params?: unknown };
    const toolName = e.toolName ?? "(unknown)";
    if (verbose) {
      const paramsPreview = safePreview(e.params, VERBOSE_PARAM_HEAD_BYTES);
      log.info(`${TAG} before_tool_call: tool=${toolName} params_head="${paramsPreview}"`);
    } else {
      log.info(`${TAG} before_tool_call: tool=${toolName}`);
    }
    return {}; // block しない
  });

  // tool_result_persist: tool 結果を AgentMessage として保存する直前
  // 公式 docs: "run before the final persistence cap" = prompt cache 注入前に走る
  api.on("tool_result_persist", (event: unknown, _ctx: unknown) => {
    if (!logging) return {};
    const e = event as { toolName?: string; toolCallId?: string; isSynthetic?: boolean };
    log.info(
      `${TAG} tool_result_persist: tool=${e.toolName ?? "(unknown)"} ` +
        `call_id=${e.toolCallId ?? "(none)"} synthetic=${e.isSynthetic ?? false}`,
    );
    return {}; // rewrite しない（message を返さない）
  });

  // before_agent_run: agent loop が走る直前。session 単位の breaker 用
  // 外部 plugin の場合 openclaw.json で allowConversationAccess: true が必要
  api.on("before_agent_run", (event: unknown, _ctx: unknown) => {
    if (!logging) return { outcome: "pass" as const };
    const e = event as {
      prompt?: string;
      messages?: unknown[];
      accountId?: string;
      channelId?: string;
      senderIsOwner?: boolean;
    };
    const promptLen = typeof e.prompt === "string" ? e.prompt.length : 0;
    const msgCount = Array.isArray(e.messages) ? e.messages.length : 0;
    log.info(
      `${TAG} before_agent_run: prompt_len=${promptLen} messages=${msgCount} ` +
        `account=${e.accountId ?? "(none)"} channel=${e.channelId ?? "(none)"} ` +
        `owner=${e.senderIsOwner ?? false}`,
    );
    return { outcome: "pass" as const };
  });
}

/**
 * 任意の value を安全に短く文字列化する。
 * - object/array → JSON.stringify
 * - string → そのまま
 * - undefined/null → "(empty)"
 * - 失敗時 → "(unserializable)"
 *
 * Phase 0 観測ログ専用。プロンプト本体や transcript 全文を吐かないため
 * VERBOSE_PARAM_HEAD_BYTES（200 byte）で切る。
 */
function safePreview(v: unknown, maxLen: number): string {
  if (v === undefined || v === null) return "(empty)";
  let s: string;
  try {
    s = typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return "(unserializable)";
  }
  s = s.replace(/\s+/g, " ").trim();
  return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s;
}
