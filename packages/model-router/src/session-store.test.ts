import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClassificationDetail } from "./classifier.js";
import { SessionStore } from "./session-store.js";

function createStore(
  overrides: { stickyWindowSize?: number; sessionTtlMs?: number; maxSessions?: number } = {},
) {
  return new SessionStore({
    stickyWindowSize: overrides.stickyWindowSize ?? 3,
    sessionTtlMs: overrides.sessionTtlMs ?? 30 * 60 * 1000,
    maxSessions: overrides.maxSessions ?? 1000,
  });
}

function detail(
  reason: ClassificationDetail["reason"],
  result: "light" | "default" = "default",
): ClassificationDetail {
  return { result, reason };
}

describe("SessionStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("未登録キー → 空の SessionContext を返す", () => {
    const store = createStore();
    const ctx = store.get("unknown-key");
    expect(ctx).toEqual({ recentTurns: [] });
  });

  it("record() + get() で記録が反映される", () => {
    const store = createStore();
    store.record("session-1", detail("force_default"));

    const ctx = store.get("session-1");
    expect(ctx.recentTurns).toHaveLength(1);
    expect(ctx.recentTurns[0].reason).toBe("force_default");
  });

  it("windowSize 超過 → 古いターンが切り捨てられる", () => {
    const store = createStore({ stickyWindowSize: 2 });

    store.record("s1", detail("force_default"));
    store.record("s1", detail("sticky_default"));
    store.record("s1", detail("light_match", "light"));

    const ctx = store.get("s1");
    expect(ctx.recentTurns).toHaveLength(2);
    expect(ctx.recentTurns[0].reason).toBe("sticky_default");
    expect(ctx.recentTurns[1].reason).toBe("light_match");
  });

  it("TTL 超過 → エントリが削除され空が返る", () => {
    const store = createStore({ sessionTtlMs: 1000 });

    store.record("s1", detail("force_default"));
    expect(store.get("s1").recentTurns).toHaveLength(1);

    // TTL 超過
    vi.advanceTimersByTime(1001);

    const ctx = store.get("s1");
    expect(ctx.recentTurns).toHaveLength(0);
    expect(store.size).toBe(0);
  });

  it("maxSessions 超過 → 最古セッションが削除される", () => {
    const store = createStore({ maxSessions: 2 });

    store.record("s1", detail("force_default"));
    store.record("s2", detail("light_match", "light"));
    expect(store.size).toBe(2);

    // 3 つ目のセッションを追加 → s1 が削除される
    store.record("s3", detail("unmatched"));
    expect(store.size).toBe(2);
    expect(store.get("s1").recentTurns).toHaveLength(0); // 削除済み
    expect(store.get("s2").recentTurns).toHaveLength(1);
    expect(store.get("s3").recentTurns).toHaveLength(1);
  });

  it("異なる sessionKey → セッションが分離される", () => {
    const store = createStore();

    store.record("line:user1", detail("force_default"));
    store.record("slack:C123", detail("light_match", "light"));

    const ctx1 = store.get("line:user1");
    const ctx2 = store.get("slack:C123");

    expect(ctx1.recentTurns).toHaveLength(1);
    expect(ctx1.recentTurns[0].reason).toBe("force_default");
    expect(ctx2.recentTurns).toHaveLength(1);
    expect(ctx2.recentTurns[0].reason).toBe("light_match");
  });

  it("get() は recentTurns のコピーを返す（参照共有しない）", () => {
    const store = createStore();
    store.record("s1", detail("force_default"));

    const ctx = store.get("s1");
    ctx.recentTurns.push({ reason: "unmatched", timestamp: 0 });

    // store 内部のデータは変更されていないこと
    expect(store.get("s1").recentTurns).toHaveLength(1);
  });

  it("TTL 超過後に record() → 新規セッションとして再開", () => {
    const store = createStore({ sessionTtlMs: 1000 });

    store.record("s1", detail("force_default"));
    vi.advanceTimersByTime(1001);

    // TTL 超過後に新しい記録
    store.record("s1", detail("light_match", "light"));

    const ctx = store.get("s1");
    expect(ctx.recentTurns).toHaveLength(1);
    expect(ctx.recentTurns[0].reason).toBe("light_match");
  });

  it("既存セッションへの record() は maxSessions を消費しない", () => {
    const store = createStore({ maxSessions: 2 });

    store.record("s1", detail("force_default"));
    store.record("s2", detail("light_match", "light"));

    // 既存セッション s1 に追加 → maxSessions に引っかからない
    store.record("s1", detail("sticky_default"));
    expect(store.size).toBe(2);
    expect(store.get("s1").recentTurns).toHaveLength(2);
  });
});
