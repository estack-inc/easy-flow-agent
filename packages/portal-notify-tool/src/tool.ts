// OpenClaw 用 notify_send ツールファクトリ。
//
// 設計方針：
//   - LLM に露出するツールは「失敗しても throw せず content[type='text'] で説明する」のが原則
//     （tool が throw すると agent ループが落ちて recovery できない）。
//   - LLM 入力（args: Record<string, unknown>）は必ず実行時バリデーションする。
//     型は TypeScript で保証されないため shape 違反を人間可読エラー text で返す。
//   - portal client が返した outcome / 投げた error を、LLM が retry 判断できる
//     テキストに整形して返す。具体的には「retry すべきか」「永続失敗か」を含める。

import type { PortalNotifyClient } from "./client.js";
import {
  type NotifyKind,
  type NotifySendInput,
  PortalAuthError,
  PortalDeliveryError,
  PortalUnavailableError,
  PortalValidationError,
} from "./types.js";

// AnyAgentTool は openclaw/plugin-sdk の型だが、本パッケージは optional peerDep にしているため
// 構造的型で必要分だけ宣言する（peerDep 未インストール環境でも build / test が通る）。
export interface AgentToolLike {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    callId: string,
    args: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

const VALID_KINDS: NotifyKind[] = ["task_completed", "reaction_received", "followup_due", "system"];

export function createNotifySendTool(client: Pick<PortalNotifyClient, "send">): AgentToolLike {
  return {
    name: "notify_send",
    description:
      "Send a notification to tenant members via the easy.flow portal. " +
      "The portal delivers the message via LINE (for members linked to the official account) or email. " +
      "Use this when an agent task completes (kind: task_completed), " +
      "an external event arrives (kind: reaction_received), " +
      "a followup is due (kind: followup_due), or " +
      "a system-level notice must be raised (kind: system). " +
      "Reusing the same idempotencyKey prevents duplicate delivery if the agent retries.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: VALID_KINDS,
          description: "Notification category for auditing and routing.",
        },
        body: {
          type: "string",
          description: "Message body (max 4000 chars).",
        },
        subject: {
          type: "string",
          description: "Email subject (max 200 chars). Ignored for LINE delivery.",
        },
        memberIds: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional. Subscription-internal member UUIDs. Omit to broadcast to all active members.",
        },
        idempotencyKey: {
          type: "string",
          description: "Optional 8-128 char key for retry-safe delivery. Use task ID + run ID.",
        },
      },
      required: ["kind", "body"],
    },
    execute: async (_callId, args) => {
      // 1) 実行時バリデーション
      const validated = validateArgs(args);
      if (!validated.ok) {
        return text(validated.error);
      }

      // 2) portal 呼び出し
      try {
        const outcome = await client.send(validated.value);

        if (outcome.ok) {
          return text(formatSuccess(outcome));
        }
        if (outcome.reason === "no_active_member") {
          return text(
            "No active member to notify (404). The subscription has no eligible recipients. " +
              "This is not a failure to retry; verify whether members are intentionally inactive.",
          );
        }
        // subscription_gone
        return text(
          "Portal returned 410 (subscription gone): the subscription is suspended or scheduled for deletion. " +
            "Do not retry — stop sending notifications for this tenant.",
        );
      } catch (err) {
        return text(formatError(err));
      }
    },
  };
}

// ─────────────────────────────────────────────────────
// バリデーション
// ─────────────────────────────────────────────────────

type ValidatedArgs = { ok: true; value: NotifySendInput } | { ok: false; error: string };

function validateArgs(args: Record<string, unknown>): ValidatedArgs {
  const kind = args.kind;
  if (typeof kind !== "string") {
    return { ok: false, error: 'invalid args: "kind" is required (string)' };
  }
  if (!(VALID_KINDS as string[]).includes(kind)) {
    return {
      ok: false,
      error: `invalid args: "kind" must be one of ${VALID_KINDS.join(", ")} (got ${JSON.stringify(kind)})`,
    };
  }
  const body = args.body;
  if (typeof body !== "string" || body.length === 0) {
    return { ok: false, error: 'invalid args: "body" is required (non-empty string)' };
  }

  const subject = args.subject;
  if (subject !== undefined && typeof subject !== "string") {
    return { ok: false, error: 'invalid args: "subject" must be a string when provided' };
  }

  const memberIdsRaw = args.memberIds;
  let memberIds: string[] | undefined;
  if (memberIdsRaw !== undefined) {
    if (!Array.isArray(memberIdsRaw)) {
      return { ok: false, error: 'invalid args: "memberIds" must be an array of UUID strings' };
    }
    for (const v of memberIdsRaw) {
      if (typeof v !== "string") {
        return {
          ok: false,
          error: 'invalid args: "memberIds" entries must all be strings',
        };
      }
    }
    memberIds = memberIdsRaw as string[];
  }

  const idempotencyKey = args.idempotencyKey;
  if (idempotencyKey !== undefined && typeof idempotencyKey !== "string") {
    return {
      ok: false,
      error: 'invalid args: "idempotencyKey" must be a string when provided',
    };
  }

  return {
    ok: true,
    value: {
      kind: kind as NotifyKind,
      body,
      ...(subject !== undefined ? { subject } : {}),
      ...(memberIds !== undefined ? { memberIds } : {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    },
  };
}

// ─────────────────────────────────────────────────────
// LLM 向け text 整形
// ─────────────────────────────────────────────────────

function formatSuccess(outcome: {
  ok: true;
  sent: number;
  pending: number;
  failed: number;
  results: Array<{ channel: "line" | "email" }>;
}): string {
  const lineCount = outcome.results.filter((r) => r.channel === "line").length;
  const emailCount = outcome.results.filter((r) => r.channel === "email").length;
  const parts: string[] = [
    `notify_send delivered: sent=${outcome.sent}, pending=${outcome.pending}, failed=${outcome.failed}`,
    `channels: line=${lineCount}, email=${emailCount}`,
  ];
  if (outcome.pending > 0) {
    parts.push(
      "Some deliveries are still pending after retry attempts. The portal may complete them asynchronously; do not retry from the agent side.",
    );
  }
  return parts.join("\n");
}

function formatError(err: unknown): string {
  if (err instanceof PortalAuthError) {
    return (
      "notify_send failed: portal rejected the notification token (401). " +
      "Do not retry. Operations must rotate or re-issue the per-subscription token."
    );
  }
  if (err instanceof PortalValidationError) {
    const details = err.details ? ` details=${JSON.stringify(err.details)}` : "";
    return (
      `notify_send failed: portal returned 400 (${err.message}).${details} ` +
      "Do not retry — this indicates a request-shape bug in the agent."
    );
  }
  if (err instanceof PortalDeliveryError) {
    return (
      `notify_send failed: portal returned 502 after retries (${err.message}). ` +
      "All recipients failed delivery. The portal already retried; do not retry immediately from the agent side."
    );
  }
  if (err instanceof PortalUnavailableError) {
    return (
      `notify_send failed: portal unreachable or 5xx (${err.message}). ` +
      "This is a transient failure; the agent may retry on the next workflow tick."
    );
  }
  if (err instanceof Error) {
    return `notify_send unexpected error: ${err.name}: ${err.message}`;
  }
  return `notify_send unexpected error: ${String(err)}`;
}

function text(message: string) {
  return { content: [{ type: "text" as const, text: message }] };
}
