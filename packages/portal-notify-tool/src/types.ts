// portal `/api/notifications/send` の入出力型と error クラス。
//
// portal 側コントラクトの正本：
//   easy-flow-real-estate-portal/lib/notifications.ts（NOTIFY_*_LEN, UUID_REGEX）
//   easy-flow-real-estate-portal/app/api/[[...route]]/route.ts（POST /api/notifications/send）
// 本ファイルでは shape のみ duplicate する（リポジトリが分かれているため）。
// 乖離した場合は portal 側の統合テストで検出する想定。

/**
 * 通知の業務カテゴリ。portal 側の `kind` 列にそのまま記録される。
 * portal は kind ごとに UI / 集計を変える可能性があるため、
 * 任意の string ではなく明示的な union で受ける。
 */
export type NotifyKind =
  | "task_completed"      // 能動型 AI のタスク完了
  | "reaction_received"   // 反響着信
  | "followup_due"        // 追客リマインド
  | "system";             // 運用通知（プラン変更・障害告知など）

/**
 * portal `POST /api/notifications/send` のリクエスト body。
 *
 * - body 最大 4000 文字
 * - subject 最大 200 文字（メール件名のみ。LINE では未使用）
 * - memberIds 省略時は subscription 内の全 active member 宛
 * - idempotencyKey 8〜128 文字。同 key の再送は portal 側で重複配信されない
 */
export interface NotifySendInput {
  kind: NotifyKind;
  body: string;
  subject?: string;
  memberIds?: string[];
  idempotencyKey?: string;
}

/**
 * portal が返す配信結果（1 member あたり 1 件）。
 * `pending` は「初回 in-flight 中なので caller は短時間後に retry すべき」状態。
 */
export interface NotifyDeliveryResult {
  memberId: string;
  notificationId: string;
  channel: "line" | "email";
  status: "sent" | "failed" | "pending";
  error?: string;
}

/**
 * portal の 200 / 502 レスポンス body。
 * - 200: sent + pending >= 1
 * - 502: 全件 failed（呼び出し側でリトライ判定）
 */
export interface NotifySendResponse {
  sent: number;
  pending: number;
  failed: number;
  results: NotifyDeliveryResult[];
}

/**
 * client.send() の戻り値。
 * portal の HTTP status を吸収して「成功 / リトライ後失敗 / 410 終了」の 3 種類で返す。
 */
export type NotifySendOutcome =
  | { ok: true; sent: number; pending: number; failed: number; results: NotifyDeliveryResult[] }
  | { ok: false; reason: "no_active_member"; status: 404 }
  | { ok: false; reason: "subscription_gone"; status: 410 };

// ─────────────────────────────────────────────────────
// Error クラス階層
//
// retry 不要 / retry 可能を caller が分岐するため、それぞれ独立クラスにする。
// すべて Error を継承する素直な階層。
// ─────────────────────────────────────────────────────

export class PortalNotifyError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "PortalNotifyError";
  }
}

/** 設定不足 / 不整合（origin / token 未設定など）。即停止すべき。 */
export class PortalNotifyConfigError extends PortalNotifyError {
  constructor(message: string) {
    super(message);
    this.name = "PortalNotifyConfigError";
  }
}

/** 401 Unauthorized：token が portal で受理されない。retry しない。 */
export class PortalAuthError extends PortalNotifyError {
  constructor(message = "portal rejected notification token (401)") {
    super(message, 401);
    this.name = "PortalAuthError";
  }
}

/** 400 Bad Request：仕様違反のリクエスト。retry しない。 */
export class PortalValidationError extends PortalNotifyError {
  /** portal が返す `missingMemberIds` 等の補助情報。caller が診断に使う。 */
  constructor(message: string, public readonly details?: Record<string, unknown>) {
    super(message, 400);
    this.name = "PortalValidationError";
  }
}

/** 502 Bad Gateway：全件 failed。retry 後も失敗した最終状態。 */
export class PortalDeliveryError extends PortalNotifyError {
  constructor(
    message: string,
    public readonly results: NotifyDeliveryResult[],
  ) {
    super(message, 502);
    this.name = "PortalDeliveryError";
  }
}

/** 想定外の 5xx / network error が retry を尽くしても続いた場合。 */
export class PortalUnavailableError extends PortalNotifyError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = "PortalUnavailableError";
  }
}
