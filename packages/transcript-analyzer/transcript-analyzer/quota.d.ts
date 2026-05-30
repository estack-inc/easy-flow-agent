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
/**
 * tenant quota / spend cap を管理する store。
 *
 * register() 内で 1 個生成し、3 tool で共有する。
 */
export declare class QuotaStore {
    private readonly sessionCounts;
    private readonly fileDayCounts;
    private readonly monthSpend;
    private readonly spendFilePath?;
    constructor(options?: QuotaStoreOptions);
    /**
     * 呼び出し前の quota check（消費なし）。
     */
    check(sessionId: string, fileHash: string, limits: QuotaLimits, now?: Date): QuotaCheckResult;
    /**
     * 呼び出し回数を 1 加算する（消費）。
     */
    consumeCall(sessionId: string, fileHash: string, now?: Date): void;
    /**
     * Gemini 呼び出しの spend を加算する。
     */
    addSpend(usd: number, now?: Date): void;
    /**
     * 現在の spend を取得（test / observability 用）
     */
    getMonthlySpend(now?: Date): number;
    /**
     * test 用：全 state を reset。
     */
    reset(): void;
    private getMonthSpend;
    private reloadSpend;
    private persistSpend;
    private withSpendLock;
}
