/**
 * cost-guard-hello: Phase 0 実証用 plugin
 *
 * 目的：
 * - OpenClaw 2026.5.12 の plugin deployment path を実機で検証（B-0/B-1 完了）
 * - before_tool_call / tool_result_persist / before_agent_run の発火順序・タイミングを観測（実証 A 完了）
 * - blockMode=block かつ blockPaths にマッチした tool 呼び出しを block する（実証 B B-3 以降）
 * - lossless-claw など bundled plugin との hook 評価順序を実測（Phase 0 実証 A）
 *
 * 動作：
 * - blockMode=observe（既定）：すべての hook 発火を api.logger.info で記録、block / rewrite はしない
 * - blockMode=block：blockPaths にマッチした path を含む tool params の呼び出しを block
 *   - tool params 内の文字列フィールドを再帰的に走査し、各 path 候補を path.resolve で canonical 化
 *   - canonical 化した path 文字列または元の文字列に blockPaths の各プレフィックスが含まれていたら block
 *   - `../` や絶対 path 混在で `/data/workspace/zoom_transcribe/` を含まないアクセス経路も block 対象に正規化
 *   - 注意：symlink 解決（realpath）や inode / device 比較は本 plugin では実施しない（B-4 の漏れパターン
 *     として Phase 1 設計に引き継ぐ）
 * - verbose=true のとき tool params の概略を最大 200 byte まで log に含める
 *
 * 詳細は easy-flow/docs/operations/transcript-cost-prevention-phase0.md 参照。
 */

import path from "node:path";

interface CostGuardHelloConfig {
  logging?: boolean;
  verbose?: boolean;
  blockMode?: "observe" | "block";
  blockPaths?: string[];
}

interface OpenClawPluginApi {
  pluginConfig?: Record<string, unknown>;
  logger: {
    info(message: string): void;
    warn?(message: string): void;
  };
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
}

const TAG = "[cost-guard-hello]";
const VERBOSE_PARAM_HEAD_BYTES = 200;

export default function register(api: OpenClawPluginApi): void {
  const cfg = (api.pluginConfig ?? {}) as CostGuardHelloConfig;
  const logging = cfg.logging ?? true;
  const verbose = cfg.verbose ?? false;
  const blockMode = cfg.blockMode ?? "observe";
  const blockPaths = Array.isArray(cfg.blockPaths)
    ? cfg.blockPaths.filter((s) => typeof s === "string" && s.length > 0)
    : [];
  const log = api.logger;
  const warn = (message: string) => (log.warn ? log.warn(message) : log.info(message));

  log.info(
    `${TAG} registered (logging=${logging}, verbose=${verbose}, ` +
      `blockMode=${blockMode}, blockPaths=${JSON.stringify(blockPaths)})`,
  );

  // before_tool_call: tool 実行直前。params 検査・block / requireApproval が可能
  api.on("before_tool_call", (event: unknown, _ctx: unknown) => {
    const e = event as { toolName?: string; params?: unknown };
    const toolName = e.toolName ?? "(unknown)";

    // block 判定（blockMode=block かつ blockPaths が空でない場合のみ）
    if (blockMode === "block" && blockPaths.length > 0) {
      const matched = findBlockMatch(e.params, blockPaths);
      if (matched) {
        warn(
          `${TAG} BLOCKED tool=${toolName} matched_path="${matched.matched}" ` +
            `via_field="${matched.field}" (blockMode=block)`,
        );
        return {
          block: true,
          blockReason: `[cost-guard-hello] path "${matched.matched}" is denied by cost-guard (matched in field "${matched.field}")`,
        };
      }
    }

    // 観測 log（block されなかった場合）
    if (logging) {
      if (verbose) {
        const paramsPreview = safePreview(e.params, VERBOSE_PARAM_HEAD_BYTES);
        log.info(`${TAG} before_tool_call: tool=${toolName} params_head="${paramsPreview}"`);
      } else {
        log.info(`${TAG} before_tool_call: tool=${toolName}`);
      }
    }
    return {};
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
  // 外部 plugin の場合 openclaw.json で plugins.entries.<id>.hooks.allowConversationAccess: true が必要
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
 * tool params を再帰的に走査し、文字列フィールドの中で blockPaths にマッチするものを探す。
 *
 * 判定ロジック：
 * 1. 文字列フィールド v ごとに、元の文字列 v と canonical 化した resolved の両方で
 *    blockPaths のいずれかのプレフィックスが includes されたら block
 * 2. canonical 化は path.resolve（`/` 起点、および params 内の cwd / workdir 等）で実施
 *    → `../`、相対 path、絶対 path 混在を吸収
 *
 * 限界（Phase 1 で対処）：
 * - symlink 解決（realpath）は実施しない：本 plugin は agent 動作前 hook なので実 FS 触らない
 * - inode / device 比較もしない
 * - `/proc/self/fd` 経由は文字列に proc が含まれている場合のみ捕捉
 * - shell injection（`$(...)` 経由）は元文字列に path が出ない場合 block 不可
 */
export function findBlockMatch(
  params: unknown,
  blockPaths: string[],
): { matched: string; field: string } | null {
  const visited = new WeakSet<object>();

  function walk(
    value: unknown,
    fieldPath: string,
    baseDirs: string[],
  ): { matched: string; field: string } | null {
    if (typeof value === "string") {
      const candidates = expandPathCandidates(value, baseDirs);
      for (const candidate of candidates) {
        for (const blocked of blockPaths) {
          if (candidate.includes(blocked)) {
            return { matched: blocked, field: fieldPath };
          }
        }
      }
      return null;
    }
    if (typeof value !== "object" || value === null) return null;
    if (visited.has(value as object)) return null;
    visited.add(value as object);

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const r = walk(value[i], `${fieldPath}[${i}]`, baseDirs);
        if (r) return r;
      }
      return null;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    const scopedBaseDirs = collectScopedBaseDirs(entries, baseDirs);
    for (const [k, v] of entries) {
      const childField = fieldPath === "" ? k : `${fieldPath}.${k}`;
      const r = walk(v, childField, scopedBaseDirs);
      if (r) return r;
    }
    return null;
  }

  return walk(params, "", []);
}

/**
 * 文字列を path-like 解釈して canonical 化候補を返す。
 *
 * 候補：
 * - 元の文字列そのまま（コマンド文字列に path が含まれている場合のため）
 * - path.resolve("/", s)（絶対パスとして resolve）
 * - path.resolve(s)（current working directory 起点で resolve）
 * - path.resolve(baseDir, s)（tool params の cwd / workdir 等を起点に resolve）
 *
 * これで `../`、`./`、相対 path 混在のケースをカバーする。`/proc/self/fd/...`
 * のような特殊 path は元の文字列のままで blockPaths プレフィックスマッチで検出する想定。
 */
function expandPathCandidates(s: string, baseDirs: string[]): string[] {
  const trimmed = s.trim();
  if (trimmed === "") return [s];
  const candidates = new Set<string>();
  candidates.add(s);
  try {
    candidates.add(path.resolve("/", trimmed));
  } catch {
    // ignore
  }
  try {
    candidates.add(path.resolve(trimmed));
  } catch {
    // ignore
  }
  for (const baseDir of baseDirs) {
    try {
      candidates.add(path.resolve(baseDir, trimmed));
    } catch {
      // ignore
    }
  }
  return [...candidates];
}

const BASE_DIR_FIELD_NAMES = new Set([
  "cwd",
  "workdir",
  "workingdir",
  "workingdirectory",
  "working_directory",
  "dir",
]);

function collectScopedBaseDirs(
  entries: [string, unknown][],
  inheritedBaseDirs: string[],
): string[] {
  const baseDirs = new Set(inheritedBaseDirs);
  for (const [key, value] of entries) {
    if (typeof value !== "string") continue;
    if (!BASE_DIR_FIELD_NAMES.has(key.toLowerCase())) continue;
    const trimmed = value.trim();
    if (trimmed === "") continue;
    try {
      baseDirs.add(path.resolve("/", trimmed));
    } catch {
      // ignore
    }
    try {
      baseDirs.add(path.resolve(trimmed));
    } catch {
      // ignore
    }
  }
  return [...baseDirs];
}

/**
 * 任意の value を安全に短く文字列化する。
 * - object/array → JSON.stringify
 * - string → そのまま
 * - undefined/null → "(empty)"
 * - 失敗時 → "(unserializable)"
 *
 * Phase 0 観測ログ専用。プロンプト本体や transcript 全文を吐かないため
 * VERBOSE_PARAM_HEAD_BYTES（最大 200 byte）で切る。
 */
function safePreview(v: unknown, maxBytes: number): string {
  if (v === undefined || v === null) return "(empty)";
  let s: string;
  try {
    s = typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return "(unserializable)";
  }
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
