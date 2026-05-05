# @openclaw/portal-notify-tool

easy.flow portal の `POST /api/notifications/send` を呼び出して、テナントに所属する社員へ
LINE / メール通知を配信する OpenClaw プラグイン。

## 役割

AI エージェント（テナント別 OpenClaw インスタンス）が**タスク完了 / 反響着信 / 追客リマインド**
等の重要イベントを社員に届けるためのパイプ。これがないと AI のアウトプットがログに留まり、
社員に届かない。

- portal 側の受け口：`easy-flow-real-estate-portal` の `POST /api/notifications/send`
- 認可：`subscriptions.notification_token`（per-subscription UUID）を Bearer で送信
- 配信先：portal 側で member の `line_user_id` 有無を見て LINE / メールに分岐

## 使い方

### 1. OpenClaw プラグインとして登録（推奨）

エージェントの設定で本パッケージを extensions に追加すると、`notify_send` ツールが
LLM の context に露出し、エージェントが任意のタイミングで通知を送れる。

```jsonc
// openclaw 設定例
{
  "plugins": {
    "portal-notify-tool": {
      "origin": "https://easy-flow-real-estate-portal.fly.dev",
      "notificationToken": "<subscriptions.notification_token>"
    }
  }
}
```

LLM 側からは以下のスキーマで呼び出せる：

```jsonc
{
  "tool": "notify_send",
  "args": {
    "kind": "task_completed",
    "subject": "SNS 投稿原稿が完成しました（3 本）",
    "body": "本日の Instagram 用原稿 3 本がドラフトに保存されました…",
    "idempotencyKey": "sns-2026-05-05-abc123"
  }
}
```

### 2. 純クライアントとして直接呼ぶ

プラグイン以外（別パッケージ・スケジューラ）から使いたい場合は client サブパスを直接 import：

```typescript
import { createPortalNotifyClient } from "@openclaw/portal-notify-tool/client";

const client = createPortalNotifyClient({
  origin: process.env.PORTAL_ORIGIN!,
  notificationToken: process.env.PORTAL_NOTIFICATION_TOKEN!,
});

const result = await client.send({
  kind: "task_completed",
  body: "...",
  idempotencyKey: "task-abc-123",
});
```

## 設定

優先順は `pluginConfig` > 環境変数 > 既定値定数。

| 設定キー (pluginConfig)  | 環境変数                         | 既定値                          | 説明 |
|--------------------------|----------------------------------|---------------------------------|------|
| `origin`                 | `PORTAL_ORIGIN`                  | （必須）                        | portal の origin URL |
| `notificationToken`      | `PORTAL_NOTIFICATION_TOKEN`      | （必須）                        | per-subscription UUID |
| `timeoutMs`              | `PORTAL_NOTIFY_TIMEOUT_MS`       | `5000`                          | HTTP timeout（ms） |
| `retryFailedDelaysMs`    | `PORTAL_NOTIFY_RETRY_FAILED_MS`  | `[10000, 30000, 90000]`         | 502 / network 失敗の指数バックオフ |
| `retryPendingDelayMs`    | `PORTAL_NOTIFY_RETRY_PENDING_MS` | `30000`                         | pending → 再送までの待機 |
| `retryPendingMaxAttempts`| `PORTAL_NOTIFY_RETRY_PENDING_MAX`| `1`                             | pending 再送の上限回数 |

ハードコーディング禁止。すべての閾値は本ファイル冒頭の `DEFAULT_PORTAL_NOTIFY_CONFIG` に
集約されており、`pluginConfig` または環境変数で全項目上書き可能。

## エラー分類

| portal 戻り値 | クライアント挙動 |
|---|---|
| `200` `sent>0` `pending=0` | 成功終了 |
| `200` `pending>0` | `retryPendingDelayMs` 後に同 `idempotencyKey` で再送（最大 `retryPendingMaxAttempts` 回） |
| `200` `sent=0` `failed>0` `pending=0` | （portal が 502 にする想定だが）即停止、`PortalDeliveryError` |
| `404` no active member | warn ログのみ、`{ ok: true, sent: 0, failed: 0 }` で終了 |
| `400` Bad Request | 即停止、`PortalValidationError` |
| `401` Unauthorized | 即停止、`PortalAuthError` |
| `410` Gone | 即停止、`PortalSubscriptionGoneError`（agent 側で全 notify を停止すべき） |
| `502` Bad Gateway | `retryFailedDelaysMs` で指数バックオフ |
| network error / その他 5xx | `retryFailedDelaysMs` で指数バックオフ |

## 関連

- portal 側コントラクト：`easy-flow-real-estate-portal/lib/notifications.ts` の定数
- portal 側 endpoint：`easy-flow-real-estate-portal/app/api/[[...route]]/route.ts`
- portal 統合テスト：`easy-flow-real-estate-portal/test/integration/notifications-send.integration.test.ts`
