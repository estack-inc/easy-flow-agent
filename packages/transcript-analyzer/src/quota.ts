/**
 * tenant quota / spend cap 管理
 *
 * contracts.md §4.2「同時実行衝突」の以下を実装：
 * - 1 session あたり 20 回 (maxAnalyzePerSession)
 * - 1 transcript あたり 1 日 50 回 (maxAnalyzePerFilePerDay)
 * - Gemini API spend：$50/月の上限 (monthlySpendCapUsd)
 *
 * 超過時は cache_status: "quota_exceeded" で明示的失敗。
 *
 * session / file-day はプロセス内 in-memory map で管理する。
 * - session counter は agent process と同じ寿命
 * - per-file-day counter は UTC day で reset
 *
 * monthly spend は plugin 再起動後も cap を維持するため、file backend を指定された場合は
 * JSON に永続化する。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

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

export interface QuotaStoreOptions {
  spendFilePath?: string;
}

interface PersistedSpendState {
  version: 1;
  monthSpend: Record<string, number>;
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

  private readonly spendFilePath?: string;

  constructor(options: QuotaStoreOptions = {}) {
    this.spendFilePath = options.spendFilePath;
    this.reloadSpend();
  }

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
    const monthSpendUsd = this.getMonthSpend(monthKey);

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
    this.withSpendLock(() => {
      this.reloadSpend();
      const previous = this.monthSpend.get(monthKey);
      this.monthSpend.set(monthKey, (previous ?? 0) + usd);
      try {
        this.persistSpend();
      } catch (err) {
        if (previous === undefined) {
          this.monthSpend.delete(monthKey);
        } else {
          this.monthSpend.set(monthKey, previous);
        }
        throw err;
      }
    });
  }

  /**
   * 現在の spend を取得（test / observability 用）
   */
  getMonthlySpend(now: Date = new Date()): number {
    return this.getMonthSpend(utcMonthKey(now));
  }

  /**
   * test 用：全 state を reset。
   */
  reset(): void {
    this.sessionCounts.clear();
    this.fileDayCounts.clear();
    this.monthSpend.clear();
    if (this.spendFilePath && existsSync(this.spendFilePath)) {
      this.withSpendLock(() => {
        this.monthSpend.clear();
        this.persistSpend();
      });
    }
  }

  private getMonthSpend(monthKey: string): number {
    this.reloadSpend();
    return this.monthSpend.get(monthKey) ?? 0;
  }

  private reloadSpend(): void {
    if (!this.spendFilePath || !existsSync(this.spendFilePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.spendFilePath, "utf8")) as PersistedSpendState;
      if (parsed.version !== 1 || typeof parsed.monthSpend !== "object" || !parsed.monthSpend) {
        return;
      }
      this.monthSpend.clear();
      for (const [monthKey, value] of Object.entries(parsed.monthSpend)) {
        if (/^\d{4}-\d{2}$/.test(monthKey) && typeof value === "number" && Number.isFinite(value)) {
          this.monthSpend.set(monthKey, value);
        }
      }
    } catch {
      // 破損した quota file は安全側に倒し、現在プロセスの値を維持する。
    }
  }

  private persistSpend(): void {
    if (!this.spendFilePath) return;
    mkdirSync(dirname(this.spendFilePath), { recursive: true });
    const state: PersistedSpendState = {
      version: 1,
      monthSpend: Object.fromEntries(this.monthSpend),
    };
    const tmpPath = `${this.spendFilePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(state), "utf8");
    renameSync(tmpPath, this.spendFilePath);
  }

  private withSpendLock<T>(fn: () => T): T {
    if (!this.spendFilePath) return fn();
    const lockDir = `${this.spendFilePath}.lock`;
    mkdirSync(dirname(this.spendFilePath), { recursive: true });
    const deadline = Date.now() + 1000;
    while (true) {
      try {
        mkdirSync(lockDir);
        break;
      } catch {
        try {
          const ageMs = Date.now() - statSync(lockDir).mtimeMs;
          if (ageMs > 30000) rmSync(lockDir, { recursive: true, force: true });
        } catch {
          // lock が消えた場合は次の loop で再試行する。
        }
        if (Date.now() >= deadline) {
          throw new Error("[transcript-analyzer] quota spend file lock timeout");
        }
        sleepSync(10);
      }
    }
    try {
      return fn();
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
