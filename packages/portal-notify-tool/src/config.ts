// portal-notify-tool の設定解決。
//
// 設計方針：
//   - 全項目（HTTP timeout / リトライ列 / pending 再送間隔等）を外部設定で上書き可能にし、
//     コードへの値の埋め込み（ハードコーディング）を禁止する。
//   - 優先順は pluginConfig > 環境変数 > DEFAULT_PORTAL_NOTIFY_CONFIG。
//     pluginConfig は OpenClaw ホスト（テナント）が宣言的に書ける場所、
//     env は Fly secrets / GitHub Actions secrets で動的差し替えする場所。
//   - 不正値（NaN / 負数 / 配列内の非数値）は早期 fail で運用事故を防ぐ。

import { PortalNotifyConfigError } from "./types.js";

/**
 * 必須 + 任意の全項目をフラット化した設定。
 * resolveConfig は origin / notificationToken を含めた完全形を返す。
 */
export interface PortalNotifyConfig {
  origin: string;
  notificationToken: string;
  timeoutMs: number;
  retryFailedDelaysMs: number[];
  retryPendingDelayMs: number;
  retryPendingMaxAttempts: number;
}

/**
 * pluginConfig に来る部分形。OpenClaw の plugin 設定 JSON や
 * createPortalNotifyClient() に渡す。
 */
export type PortalNotifyConfigInput = Partial<PortalNotifyConfig>;

/**
 * 既定値：origin / notificationToken は必須なのでここには含めない。
 * 他の閾値はすべてここに集約し、コード中に値リテラルを書かない。
 *
 * 既定値の根拠：
 *   - timeoutMs 5000：portal は通常 100〜500ms で応答。5s 超は明らかに障害扱い。
 *   - retryFailedDelaysMs [10000, 30000, 90000]：3 回・指数 3 倍・jitter は呼び出し側で付与。
 *     合計約 2 分の retry 窓で transient な portal 不調を吸収する。
 *   - retryPendingDelayMs 30000：portal の初回 in-flight 完了を 30s 待つ。
 *     LINE / メール送信の通常完了時間（数秒）に十分な余裕。
 *   - retryPendingMaxAttempts 1：pending → 1 回だけ再送。1 回でも届かなければ
 *     portal 側で stuck pending として扱われる（5 分後に portal 自身が retry）。
 */
export const DEFAULT_PORTAL_NOTIFY_CONFIG: Omit<
  PortalNotifyConfig,
  "origin" | "notificationToken"
> = {
  timeoutMs: 5000,
  retryFailedDelaysMs: [10_000, 30_000, 90_000],
  retryPendingDelayMs: 30_000,
  retryPendingMaxAttempts: 1,
};

/** 環境変数を一括 resolve する。 */
export function resolveConfig(pluginConfig: PortalNotifyConfigInput = {}): PortalNotifyConfig {
  const origin = pluginConfig.origin ?? process.env.PORTAL_ORIGIN ?? undefined;
  const notificationToken =
    pluginConfig.notificationToken ?? process.env.PORTAL_NOTIFICATION_TOKEN ?? undefined;

  if (!origin || !notificationToken) {
    throw new PortalNotifyConfigError(
      "PORTAL_ORIGIN and PORTAL_NOTIFICATION_TOKEN are required " +
        "(set via pluginConfig or environment variables)",
    );
  }

  const timeoutMs = pickPositiveInt(
    "timeoutMs",
    pluginConfig.timeoutMs,
    process.env.PORTAL_NOTIFY_TIMEOUT_MS,
    DEFAULT_PORTAL_NOTIFY_CONFIG.timeoutMs,
  );

  const retryFailedDelaysMs = pickIntArray(
    "retryFailedDelaysMs",
    pluginConfig.retryFailedDelaysMs,
    process.env.PORTAL_NOTIFY_RETRY_FAILED_MS,
    DEFAULT_PORTAL_NOTIFY_CONFIG.retryFailedDelaysMs,
  );

  const retryPendingDelayMs = pickPositiveInt(
    "retryPendingDelayMs",
    pluginConfig.retryPendingDelayMs,
    process.env.PORTAL_NOTIFY_RETRY_PENDING_MS,
    DEFAULT_PORTAL_NOTIFY_CONFIG.retryPendingDelayMs,
  );

  const retryPendingMaxAttempts = pickNonNegativeInt(
    "retryPendingMaxAttempts",
    pluginConfig.retryPendingMaxAttempts,
    process.env.PORTAL_NOTIFY_RETRY_PENDING_MAX,
    DEFAULT_PORTAL_NOTIFY_CONFIG.retryPendingMaxAttempts,
  );

  return {
    origin,
    notificationToken,
    timeoutMs,
    retryFailedDelaysMs,
    retryPendingDelayMs,
    retryPendingMaxAttempts,
  };
}

// ─────────────────────────────────────────────────────
// 内部ヘルパ
// ─────────────────────────────────────────────────────

function pickPositiveInt(
  name: string,
  pluginValue: number | undefined,
  envValue: string | undefined,
  fallback: number,
): number {
  if (pluginValue !== undefined) {
    if (!Number.isFinite(pluginValue) || pluginValue <= 0) {
      throw new PortalNotifyConfigError(`${name} must be a positive number (got ${pluginValue})`);
    }
    return pluginValue;
  }
  if (envValue !== undefined && envValue !== "") {
    const n = Number(envValue);
    if (!Number.isFinite(n) || n <= 0) {
      throw new PortalNotifyConfigError(
        `${name} env value must be a positive number (got "${envValue}")`,
      );
    }
    return n;
  }
  return fallback;
}

function pickNonNegativeInt(
  name: string,
  pluginValue: number | undefined,
  envValue: string | undefined,
  fallback: number,
): number {
  if (pluginValue !== undefined) {
    if (!Number.isFinite(pluginValue) || pluginValue < 0) {
      throw new PortalNotifyConfigError(
        `${name} must be a non-negative number (got ${pluginValue})`,
      );
    }
    return pluginValue;
  }
  if (envValue !== undefined && envValue !== "") {
    const n = Number(envValue);
    if (!Number.isFinite(n) || n < 0) {
      throw new PortalNotifyConfigError(
        `${name} env value must be a non-negative number (got "${envValue}")`,
      );
    }
    return n;
  }
  return fallback;
}

function pickIntArray(
  name: string,
  pluginValue: number[] | undefined,
  envValue: string | undefined,
  fallback: number[],
): number[] {
  if (pluginValue !== undefined) {
    for (const v of pluginValue) {
      if (!Number.isFinite(v) || v < 0) {
        throw new PortalNotifyConfigError(
          `${name} entries must be non-negative numbers (got ${v})`,
        );
      }
    }
    return [...pluginValue];
  }
  if (envValue !== undefined && envValue !== "") {
    const parts = envValue
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const out: number[] = [];
    for (const p of parts) {
      const n = Number(p);
      if (!Number.isFinite(n) || n < 0) {
        throw new PortalNotifyConfigError(
          `${name} env value must be comma-separated non-negative numbers (got "${envValue}")`,
        );
      }
      out.push(n);
    }
    return out;
  }
  return [...fallback];
}
