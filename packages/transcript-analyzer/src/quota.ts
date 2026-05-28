/**
 * tenant quota / spend cap 管理
 *
 * contracts.md §4.2「同時実行衝突」の以下を実装：
 * - 1 session あたり 20 回 (maxAnalyzePerSession)
 * - 1 transcript あたり 1 日 50 回 (maxAnalyzePerFilePerDay)
 * - Gemini API spend：$50/instance/月の上限 (monthlySpendCapUsd)
 *
 * 超過時は cache_status: "quota_exceeded" で明示的失敗。
 *
 * 永続層を持たない設計：プロセス内 in-memory map で管理する。
 * - session counter は agent process と同じ寿命
 * - per-file-day counter は UTC day で reset
 * - spend は月初で reset
 *
 * pgvector / file 永続化は Phase 2 で実装。Phase 1 は in-memory で十分。
 */

export interface QuotaLimits {
  maxAnalyzePerSession: number;
  maxAnalyzePerFilePerDay: number;
  monthlySpendCapUsd: number;
}

export interface QuotaCheckResult {
  allowed: boolean;
  reason?: "session_limit" | "file_day_limit" | "spend_cap";
  current?: {
    sessionCount: number;
    fileDayCount: number;
    monthSpendUsd: number;
  };
}

/**
 * tenant quota / spend cap を管理する store。
 *
 * register() 内で 1 個生成し、3 tool で共有する。
 */
export class QuotaStore {
  // session_id -> 累積 analyze 回数
  private readonly sessionCounts = new Map<string, number>();

  // `${file_hash}|${YYYY-MM-DD}` -> 累積 analyze 回数
  private readonly fileDayCounts = new Map<string, number>();

  // YYYY-MM -> 累積 spend USD
  private readonly monthSpend = new Map<string, number>();

  /**
   * 呼び出し前の quota check（消費なし）。
   */
  check(
    sessionId: string,
    fileHash: string,
    limits: QuotaLimits,
    now: Date = new Date(),
  ): QuotaCheckResult {
    const sessionKey = sessionId || "default";
    const fileDayKey = `${fileHash}|${utcDayKey(now)}`;
    const monthKey = utcMonthKey(now);

    const sessionCount = this.sessionCounts.get(sessionKey) ?? 0;
    const fileDayCount = this.fileDayCounts.get(fileDayKey) ?? 0;
    const monthSpendUsd = this.monthSpend.get(monthKey) ?? 0;

    if (sessionCount >= limits.maxAnalyzePerSession) {
      return {
        allowed: false,
        reason: "session_limit",
        current: { sessionCount, fileDayCount, monthSpendUsd },
      };
    }
    if (fileDayCount >= limits.maxAnalyzePerFilePerDay) {
      return {
        allowed: false,
        reason: "file_day_limit",
        current: { sessionCount, fileDayCount, monthSpendUsd },
      };
    }
    if (monthSpendUsd >= limits.monthlySpendCapUsd) {
      return {
        allowed: false,
        reason: "spend_cap",
        current: { sessionCount, fileDayCount, monthSpendUsd },
      };
    }
    return {
      allowed: true,
      current: { sessionCount, fileDayCount, monthSpendUsd },
    };
  }

  /**
   * 呼び出し回数を 1 加算する（消費）。
   */
  consumeCall(sessionId: string, fileHash: string, now: Date = new Date()): void {
    const sessionKey = sessionId || "default";
    const fileDayKey = `${fileHash}|${utcDayKey(now)}`;

    this.sessionCounts.set(sessionKey, (this.sessionCounts.get(sessionKey) ?? 0) + 1);
    this.fileDayCounts.set(fileDayKey, (this.fileDayCounts.get(fileDayKey) ?? 0) + 1);
  }

  /**
   * Gemini 呼び出しの spend を加算する。
   */
  addSpend(usd: number, now: Date = new Date()): void {
    if (usd <= 0 || !Number.isFinite(usd)) return;
    const monthKey = utcMonthKey(now);
    this.monthSpend.set(monthKey, (this.monthSpend.get(monthKey) ?? 0) + usd);
  }

  /**
   * 現在の spend を取得（test / observability 用）
   */
  getMonthlySpend(now: Date = new Date()): number {
    return this.monthSpend.get(utcMonthKey(now)) ?? 0;
  }

  /**
   * test 用：全 state を reset。
   */
  reset(): void {
    this.sessionCounts.clear();
    this.fileDayCounts.clear();
    this.monthSpend.clear();
  }
}

function utcDayKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function utcMonthKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}
