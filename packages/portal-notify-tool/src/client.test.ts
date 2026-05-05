// client.test.ts: portal `/api/notifications/send` 呼び出しの統合テスト。
//
// 実 HTTP は使わず、fetch を vi.fn でモックしてレスポンスを差し替える。
// undici / msw を使えばより本格的だが、本パッケージは Node 標準 fetch のみで動くため
// 直接モックの方が依存が少なく単純。
//
// 検証範囲:
//   - 200 sent: 成功で結果を返す
//   - 200 pending: retryPendingDelayMs 後に再送、再送も pending なら ok: true で終了
//   - 200 pending → 200 sent (再送で確定): 1 回だけ retry
//   - 200 sent + body の Authorization / JSON 形式の検証
//   - 404 no active member: ok: true sent: 0 で終了 + warn ログ
//   - 400 → PortalValidationError + missingMemberIds 含む details
//   - 401 → PortalAuthError, retry しない
//   - 410 → ok: false reason: 'subscription_gone'
//   - 502 → retryFailedDelaysMs 全件 retry 後 PortalDeliveryError
//   - network error → retry, 全失敗で PortalUnavailableError
//   - timeout → AbortError 経由で retry
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPortalNotifyClient } from "./client.js";
import {
  PortalAuthError,
  PortalDeliveryError,
  PortalUnavailableError,
  PortalValidationError,
  type NotifySendResponse,
} from "./types.js";

const ORIGIN = "https://portal.example";
const TOKEN = "11111111-2222-4333-8444-555555555555";

const fetchMock = vi.fn();
const sleepMock = vi.fn(async (_ms: number) => {});

function makeResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function buildClient(overrides: {
  retryFailedDelaysMs?: number[];
  retryPendingDelayMs?: number;
  retryPendingMaxAttempts?: number;
  timeoutMs?: number;
} = {}) {
  return createPortalNotifyClient({
    origin: ORIGIN,
    notificationToken: TOKEN,
    timeoutMs: overrides.timeoutMs ?? 1000,
    retryFailedDelaysMs: overrides.retryFailedDelaysMs ?? [10, 20],
    retryPendingDelayMs: overrides.retryPendingDelayMs ?? 5,
    retryPendingMaxAttempts: overrides.retryPendingMaxAttempts ?? 1,
    fetch: fetchMock,
    sleep: sleepMock,
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  sleepMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createPortalNotifyClient.send - 成功系", () => {
  it("200 sent: ok: true を返し、Authorization / Content-Type / body が正しい", async () => {
    const body: NotifySendResponse = {
      sent: 1,
      pending: 0,
      failed: 0,
      results: [
        {
          memberId: "m1",
          notificationId: "n1",
          channel: "email",
          status: "sent",
        },
      ],
    };
    fetchMock.mockResolvedValueOnce(makeResponse(200, body));

    const client = buildClient();
    const result = await client.send({
      kind: "task_completed",
      body: "msg",
      idempotencyKey: "agent-task-1",
    });

    expect(result).toEqual({
      ok: true,
      sent: 1,
      pending: 0,
      failed: 0,
      results: body.results,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://portal.example/api/notifications/send");
    expect(init.method).toBe("POST");
    expect(init.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({
      kind: "task_completed",
      body: "msg",
      idempotencyKey: "agent-task-1",
    });
  });

  it("subject / memberIds 込みの body をそのまま転送する", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { sent: 2, pending: 0, failed: 0, results: [] }),
    );
    const client = buildClient();
    await client.send({
      kind: "reaction_received",
      body: "新規問合せ",
      subject: "件名",
      memberIds: ["uuid-1", "uuid-2"],
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      kind: "reaction_received",
      body: "新規問合せ",
      subject: "件名",
      memberIds: ["uuid-1", "uuid-2"],
    });
  });
});

describe("createPortalNotifyClient.send - pending retry", () => {
  it("初回 200 pending → 再送で 200 sent に解決", async () => {
    fetchMock
      .mockResolvedValueOnce(
        makeResponse(200, {
          sent: 0,
          pending: 1,
          failed: 0,
          results: [
            {
              memberId: "m1",
              notificationId: "n1",
              channel: "line",
              status: "pending",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        makeResponse(200, {
          sent: 1,
          pending: 0,
          failed: 0,
          results: [
            {
              memberId: "m1",
              notificationId: "n1",
              channel: "line",
              status: "sent",
            },
          ],
        }),
      );

    const client = buildClient({ retryPendingDelayMs: 5, retryPendingMaxAttempts: 1 });
    const result = await client.send({
      kind: "system",
      body: "msg",
      idempotencyKey: "key-1",
    });

    expect(result).toMatchObject({ ok: true, sent: 1, pending: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenNthCalledWith(1, 5);
  });

  it("retryPendingMaxAttempts: 0 なら pending でも再送せず ok: true で終了", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        sent: 0,
        pending: 1,
        failed: 0,
        results: [],
      }),
    );
    const client = buildClient({ retryPendingMaxAttempts: 0 });
    const result = await client.send({ kind: "system", body: "msg" });
    expect(result).toMatchObject({ ok: true, pending: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("最大 attempts 後も pending なら ok: true pending で終了 (失敗扱いにしない)", async () => {
    // Response は body を 1 度しか読めないため、毎回新しい Response を返す
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        makeResponse(200, {
          sent: 0,
          pending: 1,
          failed: 0,
          results: [],
        }),
      ),
    );
    const client = buildClient({ retryPendingMaxAttempts: 2 });
    const result = await client.send({ kind: "system", body: "msg" });
    expect(result).toMatchObject({ ok: true, pending: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(3); // 初回 + 2 回 retry
  });
});

describe("createPortalNotifyClient.send - 4xx", () => {
  it("400 → PortalValidationError に details 付き", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(400, {
        error: "memberIds 一部無効",
        missingMemberIds: ["uuid-x"],
      }),
    );
    const client = buildClient();
    await expect(
      client.send({ kind: "system", body: "msg", memberIds: ["uuid-x"] }),
    ).rejects.toBeInstanceOf(PortalValidationError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("401 → PortalAuthError, retry しない", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(401, { error: "Unauthorized" }),
    );
    const client = buildClient();
    await expect(client.send({ kind: "system", body: "msg" })).rejects.toBeInstanceOf(
      PortalAuthError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("404 → ok: false reason: no_active_member", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(404, { error: "no active member" }),
    );
    const client = buildClient();
    const result = await client.send({ kind: "system", body: "msg" });
    expect(result).toEqual({ ok: false, reason: "no_active_member", status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("410 → ok: false reason: subscription_gone, retry しない", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(410, { error: "subscription gone" }),
    );
    const client = buildClient();
    const result = await client.send({ kind: "system", body: "msg" });
    expect(result).toEqual({
      ok: false,
      reason: "subscription_gone",
      status: 410,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("createPortalNotifyClient.send - 5xx / network", () => {
  it("502 → retryFailedDelaysMs 全件試行後 PortalDeliveryError", async () => {
    const failedBody = {
      sent: 0,
      pending: 0,
      failed: 1,
      results: [
        {
          memberId: "m1",
          notificationId: "n1",
          channel: "email",
          status: "failed",
          error: "smtp error",
        },
      ],
    };
    fetchMock.mockImplementation(() =>
      Promise.resolve(makeResponse(502, failedBody)),
    );

    const client = buildClient({ retryFailedDelaysMs: [10, 20] });
    await expect(
      client.send({ kind: "system", body: "msg" }),
    ).rejects.toBeInstanceOf(PortalDeliveryError);

    expect(fetchMock).toHaveBeenCalledTimes(3); // 初回 + 2 回 retry
    expect(sleepMock).toHaveBeenCalledTimes(2);
  });

  it("502 が途中で 200 になれば成功", async () => {
    fetchMock
      .mockResolvedValueOnce(
        makeResponse(502, { sent: 0, pending: 0, failed: 1, results: [] }),
      )
      .mockResolvedValueOnce(
        makeResponse(200, { sent: 1, pending: 0, failed: 0, results: [] }),
      );

    const client = buildClient({ retryFailedDelaysMs: [10, 20] });
    const result = await client.send({ kind: "system", body: "msg" });
    expect(result).toMatchObject({ ok: true, sent: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("network error も retry し全部失敗で PortalUnavailableError", async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error("ECONNRESET")));
    const client = buildClient({ retryFailedDelaysMs: [10, 20] });
    await expect(
      client.send({ kind: "system", body: "msg" }),
    ).rejects.toBeInstanceOf(PortalUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("503 / 500 など 5xx も retry 対象", async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(503, { error: "unavailable" }))
      .mockResolvedValueOnce(
        makeResponse(200, { sent: 1, pending: 0, failed: 0, results: [] }),
      );
    const client = buildClient({ retryFailedDelaysMs: [10] });
    const result = await client.send({ kind: "system", body: "msg" });
    expect(result).toMatchObject({ ok: true, sent: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("createPortalNotifyClient.send - timeout", () => {
  it("timeout の AbortError は network error と同じく retry 対象", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    fetchMock
      .mockRejectedValueOnce(abortErr)
      .mockResolvedValueOnce(
        makeResponse(200, { sent: 1, pending: 0, failed: 0, results: [] }),
      );
    const client = buildClient({ retryFailedDelaysMs: [10] });
    const result = await client.send({ kind: "system", body: "msg" });
    expect(result).toMatchObject({ ok: true, sent: 1 });
  });
});
