// portal `/api/notifications/send` を呼び出す HTTP クライアント。
//
// 設計方針：
//   - fetch / sleep を DI 可能にして、テストでは vi.fn でモック・本番では Node 標準 fetch / setTimeout を使う
//   - portal の HTTP status を outcome 型に吸収し、caller は ok / reason 単位で分岐できる
//   - retry 対象は 502 / 5xx / network error。4xx と 410 は即停止
//   - pending（200 だが pending>=1）は同 idempotencyKey で再送する別経路で扱う
//   - すべての閾値は config 経由で外部設定（ハードコーディング禁止）
//
// 重要：portal 側の契約定数（body 4000 文字 / subject 200 文字 / memberIds 50 件 /
// idempotencyKey 8〜128 文字）は portal が validate するためここでは pre-check しない。
// 不正な input は 400 → PortalValidationError として返ってくる。

import {
  type PortalNotifyConfig,
  type PortalNotifyConfigInput,
  resolveConfig,
} from "./config.js";
import { addJitter, retryWithBackoff, type RetryStep } from "./retry.js";
import {
  type NotifyDeliveryResult,
  type NotifySendInput,
  type NotifySendOutcome,
  type NotifySendResponse,
  PortalAuthError,
  PortalDeliveryError,
  PortalUnavailableError,
  PortalValidationError,
} from "./types.js";

/** Node 標準 fetch のサブセット（依存性注入用）。 */
export type FetchLike = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export interface CreatePortalNotifyClientOptions extends PortalNotifyConfigInput {
  /** Override fetch (default: globalThis.fetch). テスト用。 */
  fetch?: FetchLike;
  /** Override sleep (default: setTimeout 基底). テスト用。 */
  sleep?: (ms: number) => Promise<void>;
}

export interface PortalNotifyClient {
  send(input: NotifySendInput): Promise<NotifySendOutcome>;
  readonly config: Readonly<PortalNotifyConfig>;
}

/** 既定の sleep（setTimeout ベース）。 */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function createPortalNotifyClient(
  opts: CreatePortalNotifyClientOptions,
): PortalNotifyClient {
  const cfg = resolveConfig(opts);
  const fetchImpl: FetchLike = opts.fetch ?? (globalThis.fetch as FetchLike);
  const sleep = opts.sleep ?? defaultSleep;

  return {
    config: cfg,
    async send(input: NotifySendInput): Promise<NotifySendOutcome> {
      // 1) 502 / 5xx / network error は retryWithBackoff で吸収
      const baseOutcome = await retryWithBackoff(
        () => attemptSend(input, cfg, fetchImpl),
        cfg.retryFailedDelaysMs.map(addJitter),
        sleep,
      );

      // 2) 成功時、pending を含むなら同 idempotencyKey で再送して確定を狙う
      if (baseOutcome.kind === "ok" && baseOutcome.response.pending > 0) {
        return await retryPending(
          input,
          baseOutcome.response,
          cfg,
          fetchImpl,
          sleep,
        );
      }

      // outcome → public NotifySendOutcome に正規化
      return materializeOutcome(baseOutcome);
    },
  };
}

// ─────────────────────────────────────────────────────
// 内部：1 回の HTTP 試行。retry すべきかは戻り値の retry フラグで表す。
// ─────────────────────────────────────────────────────

type AttemptResult =
  | { kind: "ok"; response: NotifySendResponse }
  | { kind: "no_active_member"; status: 404 }
  | { kind: "subscription_gone"; status: 410 };

async function attemptSend(
  input: NotifySendInput,
  cfg: PortalNotifyConfig,
  fetchImpl: FetchLike,
): Promise<RetryStep<AttemptResult>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  let res: Response;
  try {
    res = await fetchImpl(`${cfg.origin}/api/notifications/send`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.notificationToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
  } catch (err) {
    // network error / abort はすべて retry 対象。最終的に retry を尽くしたら
    // PortalUnavailableError に置き換える（catch ブロック側で wrap）。
    return {
      retry: true,
      error: wrapNetworkError(err),
    };
  } finally {
    clearTimeout(timer);
  }

  // 4xx / 410 / 404 は retry しない。throw or 結果値で即終了。
  if (res.status === 200) {
    const body = (await res.json()) as NotifySendResponse;
    return { retry: false, value: { kind: "ok", response: body } };
  }
  if (res.status === 404) {
    return { retry: false, value: { kind: "no_active_member", status: 404 } };
  }
  if (res.status === 410) {
    return { retry: false, value: { kind: "subscription_gone", status: 410 } };
  }
  if (res.status === 401) {
    throw new PortalAuthError();
  }
  if (res.status === 400) {
    let details: Record<string, unknown> | undefined;
    try {
      details = (await res.json()) as Record<string, unknown>;
    } catch {
      details = undefined;
    }
    throw new PortalValidationError(
      `portal rejected request (400): ${details?.error ?? "unknown"}`,
      details,
    );
  }
  if (res.status === 502) {
    // retry 対象。最終的に PortalDeliveryError に置き換える（caller 側）。
    let body: NotifySendResponse | undefined;
    try {
      body = (await res.json()) as NotifySendResponse;
    } catch {
      body = undefined;
    }
    return {
      retry: true,
      error: new PortalDeliveryError(
        "portal returned 502 (all delivery attempts failed)",
        body?.results ?? [],
      ),
    };
  }
  // それ以外の 5xx / 異常 status はすべて retry 対象（transient と見なす）
  return {
    retry: true,
    error: new PortalUnavailableError(
      `portal returned unexpected status ${res.status}`,
      res.status,
    ),
  };
}

// ─────────────────────────────────────────────────────
// 内部：pending 再送（同 idempotencyKey で N 回まで）
// ─────────────────────────────────────────────────────

async function retryPending(
  input: NotifySendInput,
  initialResponse: NotifySendResponse,
  cfg: PortalNotifyConfig,
  fetchImpl: FetchLike,
  sleep: (ms: number) => Promise<void>,
): Promise<NotifySendOutcome> {
  let current = initialResponse;
  for (let i = 0; i < cfg.retryPendingMaxAttempts; i++) {
    await sleep(cfg.retryPendingDelayMs);
    const step = await attemptSend(input, cfg, fetchImpl);
    if (step.retry) {
      // retry 中の transient 失敗は throw（pending 再送で 5xx は希）
      throw step.error;
    }
    if (step.value.kind !== "ok") {
      // 410 / 404 への遷移：そのまま返す
      return materializeOutcome(step.value);
    }
    current = step.value.response;
    if (current.pending === 0) break;
  }
  // 上限に達してもまだ pending がいれば ok: true で返す（caller 判断に委ねる）
  return {
    ok: true,
    sent: current.sent,
    pending: current.pending,
    failed: current.failed,
    results: current.results,
  };
}

// ─────────────────────────────────────────────────────
// 内部：AttemptResult → NotifySendOutcome への正規化
// ─────────────────────────────────────────────────────

function materializeOutcome(r: AttemptResult): NotifySendOutcome {
  if (r.kind === "ok") {
    return {
      ok: true,
      sent: r.response.sent,
      pending: r.response.pending,
      failed: r.response.failed,
      results: r.response.results,
    };
  }
  if (r.kind === "no_active_member") {
    return { ok: false, reason: "no_active_member", status: 404 };
  }
  return { ok: false, reason: "subscription_gone", status: 410 };
}

// ─────────────────────────────────────────────────────
// 内部：retry を尽くした後、最後の error を最終形に変換
// ─────────────────────────────────────────────────────

function wrapNetworkError(err: unknown): PortalUnavailableError {
  if (err instanceof PortalUnavailableError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new PortalUnavailableError(`portal request failed: ${msg}`);
}

// 最後に export しておく：caller が NotifyDeliveryResult 等を再 export せずに済むよう
export type { NotifyDeliveryResult, NotifySendInput, NotifySendOutcome };
