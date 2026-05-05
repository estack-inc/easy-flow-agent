// tool.test.ts: createNotifySendTool が portal-notify-client をラップして
// OpenClaw の AnyAgentTool を返すことを検証する。
//
// 確認したいこと：
//   - LLM 入力（args）の型ガード（kind 必須・enum 値・body 必須・型違反は人間可読エラー）
//   - portal client の send を 1 回呼ぶ（args をそのまま渡す）
//   - 200 sent / 200 pending / 410 / Error をそれぞれ LLM 向けに整形した text に変換
//   - PortalAuthError / PortalValidationError は LLM に「retry するな」を伝えるテキスト
//   - 想定外の例外も人間可読エラーで返す
import { describe, expect, it, vi } from "vitest";
import { createNotifySendTool } from "./tool.js";
import {
  type NotifySendInput,
  type NotifySendOutcome,
  PortalAuthError,
  PortalDeliveryError,
  PortalUnavailableError,
  PortalValidationError,
} from "./types.js";

function makeClient(send: (input: NotifySendInput) => Promise<NotifySendOutcome>) {
  return {
    config: {} as never,
    send: vi.fn(send),
  };
}

describe("createNotifySendTool - スキーマ", () => {
  it("name / description / parameters が定義されている", () => {
    const client = makeClient(async () => ({
      ok: true,
      sent: 0,
      pending: 0,
      failed: 0,
      results: [],
    }));
    const tool = createNotifySendTool(client);
    expect(tool.name).toBe("notify_send");
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.parameters).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["kind", "body"]),
    });
  });
});

describe("createNotifySendTool - 入力バリデーション", () => {
  it("kind 不在は LLM 向けエラー text を返す", async () => {
    const client = makeClient(async () => {
      throw new Error("should not be called");
    });
    const tool = createNotifySendTool(client);
    const result = await tool.execute("call-1", { body: "msg" });
    expect(result.content[0].type).toBe("text");
    expect((result.content[0] as { text: string }).text).toMatch(/kind/);
    expect(client.send).not.toHaveBeenCalled();
  });

  it("kind が enum 外は エラー text", async () => {
    const client = makeClient(async () => {
      throw new Error("should not be called");
    });
    const tool = createNotifySendTool(client);
    const result = await tool.execute("call-1", {
      kind: "spam_send",
      body: "msg",
    });
    expect((result.content[0] as { text: string }).text).toMatch(/kind/);
    expect(client.send).not.toHaveBeenCalled();
  });

  it("body 不在は エラー text", async () => {
    const client = makeClient(async () => {
      throw new Error("should not be called");
    });
    const tool = createNotifySendTool(client);
    const result = await tool.execute("call-1", { kind: "system" });
    expect((result.content[0] as { text: string }).text).toMatch(/body/);
    expect(client.send).not.toHaveBeenCalled();
  });

  it("memberIds が array 以外なら エラー text", async () => {
    const client = makeClient(async () => {
      throw new Error("should not be called");
    });
    const tool = createNotifySendTool(client);
    const result = await tool.execute("call-1", {
      kind: "system",
      body: "msg",
      memberIds: "uuid-1",
    });
    expect((result.content[0] as { text: string }).text).toMatch(/memberIds/);
  });
});

describe("createNotifySendTool - 正常系", () => {
  it("client.send に args を構造化して渡す", async () => {
    const client = makeClient(async () => ({
      ok: true,
      sent: 1,
      pending: 0,
      failed: 0,
      results: [],
    }));
    const tool = createNotifySendTool(client);
    await tool.execute("call-1", {
      kind: "task_completed",
      body: "msg",
      subject: "件名",
      memberIds: ["uuid-1", "uuid-2"],
      idempotencyKey: "key-1",
    });
    expect(client.send).toHaveBeenCalledWith({
      kind: "task_completed",
      body: "msg",
      subject: "件名",
      memberIds: ["uuid-1", "uuid-2"],
      idempotencyKey: "key-1",
    });
  });

  it("ok: true sent 結果は LLM 向けに件数を整形した text を返す", async () => {
    const client = makeClient(async () => ({
      ok: true,
      sent: 3,
      pending: 0,
      failed: 0,
      results: [
        { memberId: "m1", notificationId: "n1", channel: "line", status: "sent" },
        { memberId: "m2", notificationId: "n2", channel: "line", status: "sent" },
        { memberId: "m3", notificationId: "n3", channel: "email", status: "sent" },
      ],
    }));
    const tool = createNotifySendTool(client);
    const result = await tool.execute("call-1", { kind: "system", body: "msg" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/sent.*3/);
    expect(text).toMatch(/line.*2/);
    expect(text).toMatch(/email.*1/);
  });

  it("ok: true pending を含む結果は「未確定あり」と LLM に伝える", async () => {
    const client = makeClient(async () => ({
      ok: true,
      sent: 1,
      pending: 1,
      failed: 0,
      results: [],
    }));
    const tool = createNotifySendTool(client);
    const result = await tool.execute("call-1", { kind: "system", body: "msg" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/pending/i);
  });
});

describe("createNotifySendTool - 異常系", () => {
  it("ok: false reason: no_active_member は warn 系 text", async () => {
    const client = makeClient(async () => ({
      ok: false,
      reason: "no_active_member",
      status: 404,
    }));
    const tool = createNotifySendTool(client);
    const result = await tool.execute("call-1", { kind: "system", body: "msg" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/active member/);
  });

  it("ok: false reason: subscription_gone は永続失敗で「retry しないで」と伝える", async () => {
    const client = makeClient(async () => ({
      ok: false,
      reason: "subscription_gone",
      status: 410,
    }));
    const tool = createNotifySendTool(client);
    const result = await tool.execute("call-1", { kind: "system", body: "msg" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/subscription/);
    expect(text).toMatch(/retry|再試行|do not/i);
  });

  it("PortalAuthError は永続失敗 (retry 不要) を LLM に伝える", async () => {
    const client = makeClient(async () => {
      throw new PortalAuthError();
    });
    const tool = createNotifySendTool(client);
    const result = await tool.execute("call-1", { kind: "system", body: "msg" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/auth|token|401/i);
    expect(text).toMatch(/retry|再試行|do not/i);
  });

  it("PortalValidationError は仕様違反として詳細を含めて返す", async () => {
    const client = makeClient(async () => {
      throw new PortalValidationError("memberIds 一部無効", {
        missingMemberIds: ["uuid-x"],
      });
    });
    const tool = createNotifySendTool(client);
    const result = await tool.execute("call-1", { kind: "system", body: "msg" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/memberIds 一部無効|400/);
  });

  it("PortalDeliveryError は外部配信失敗として LLM に伝える", async () => {
    const client = makeClient(async () => {
      throw new PortalDeliveryError("502 reached after retries", []);
    });
    const tool = createNotifySendTool(client);
    const result = await tool.execute("call-1", { kind: "system", body: "msg" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/502|delivery|配信/i);
  });

  it("PortalUnavailableError は network / 5xx 失敗として「後で retry 可」を伝える", async () => {
    const client = makeClient(async () => {
      throw new PortalUnavailableError("ECONNRESET");
    });
    const tool = createNotifySendTool(client);
    const result = await tool.execute("call-1", { kind: "system", body: "msg" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/ECONNRESET|unavailable|接続/i);
  });

  it("想定外の例外も人間可読 text で返す（throw しない）", async () => {
    const client = makeClient(async () => {
      throw new TypeError("nope");
    });
    const tool = createNotifySendTool(client);
    const result = await tool.execute("call-1", { kind: "system", body: "msg" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/nope|error/i);
  });
});
