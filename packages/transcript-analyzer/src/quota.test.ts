/**
 * quota / spend cap の単体テスト
 *
 * - session 20 / file-day 50 / month spend $50 の閾値
 * - reset 動作
 * - UTC 日付境界
 */

import { describe, expect, it } from "vitest";
import { QuotaStore } from "./quota.js";

const LIMITS = {
  maxAnalyzePerSession: 20,
  maxAnalyzePerFilePerDay: 50,
  monthlySpendCapUsd: 50,
};

describe("QuotaStore.check", () => {
  it("初期は allowed", () => {
    const s = new QuotaStore();
    const r = s.check("session-1", "hash-1", LIMITS);
    expect(r.allowed).toBe(true);
  });

  it("session 20 回到達で session_limit を返す", () => {
    const s = new QuotaStore();
    for (let i = 0; i < 20; i++) s.consumeCall("s", "h", new Date());
    const r = s.check("s", "h", LIMITS);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("session_limit");
  });

  it("file-day 50 回到達で file_day_limit を返す", () => {
    const s = new QuotaStore();
    // 各セッションを別 ID にして session_limit ではなく file_day_limit が先に当たる状況を作る
    for (let i = 0; i < 50; i++) s.consumeCall(`s-${i}`, "h", new Date());
    const r = s.check(`s-new`, "h", LIMITS);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("file_day_limit");
  });

  it("spend cap 到達で spend_cap を返す", () => {
    const s = new QuotaStore();
    s.addSpend(50);
    const r = s.check("s", "h", LIMITS);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("spend_cap");
  });

  it("addSpend は負値 / Inf を無視", () => {
    const s = new QuotaStore();
    s.addSpend(-1);
    s.addSpend(Number.POSITIVE_INFINITY);
    s.addSpend(Number.NaN);
    expect(s.getMonthlySpend()).toBe(0);
  });

  it("getMonthlySpend が現在月の累積を返す", () => {
    const s = new QuotaStore();
    s.addSpend(1.5);
    s.addSpend(2.0);
    expect(s.getMonthlySpend()).toBeCloseTo(3.5);
  });

  it("reset で全 state がクリア", () => {
    const s = new QuotaStore();
    for (let i = 0; i < 20; i++) s.consumeCall("s", "h", new Date());
    s.addSpend(50);
    s.reset();
    const r = s.check("s", "h", LIMITS);
    expect(r.allowed).toBe(true);
  });

  it("UTC 日付が変わると file-day counter が reset", () => {
    const s = new QuotaStore();
    const day1 = new Date("2026-05-28T12:00:00Z");
    const day2 = new Date("2026-05-29T12:00:00Z");
    for (let i = 0; i < 50; i++) s.consumeCall(`s-${i}`, "h", day1);
    expect(s.check(`s-new`, "h", LIMITS, day1).allowed).toBe(false);
    expect(s.check(`s-new`, "h", LIMITS, day2).allowed).toBe(true);
  });

  it("月が変わると spend counter が reset", () => {
    const s = new QuotaStore();
    const m1 = new Date("2026-05-15T12:00:00Z");
    const m2 = new Date("2026-06-01T12:00:00Z");
    s.addSpend(50, m1);
    expect(s.check("s", "h", LIMITS, m1).allowed).toBe(false);
    expect(s.check("s", "h", LIMITS, m2).allowed).toBe(true);
  });

  it("sessionId 空文字列は default として扱う", () => {
    const s = new QuotaStore();
    for (let i = 0; i < 20; i++) s.consumeCall("", "h");
    const r = s.check("", "h", LIMITS);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("session_limit");
  });
});
