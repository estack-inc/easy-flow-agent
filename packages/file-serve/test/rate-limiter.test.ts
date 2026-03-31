import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimiter } from "../src/rate-limiter.js";

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("基本動作", () => {
    it("maxRequests 以内のリクエストは許可される", () => {
      const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 3 });

      expect(limiter.check("10.0.0.1").allowed).toBe(true);
      expect(limiter.check("10.0.0.1").allowed).toBe(true);
      expect(limiter.check("10.0.0.1").allowed).toBe(true);
    });

    it("maxRequests 超過後は拒否される", () => {
      const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 2 });

      limiter.check("10.0.0.1");
      limiter.check("10.0.0.1");
      const result = limiter.check("10.0.0.1");

      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.retryAfterMs).toBeGreaterThan(0);
      }
    });

    it("windowMs 経過後はカウントがリセットされ再び許可される", () => {
      const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 1 });

      limiter.check("10.0.0.1");
      const blocked = limiter.check("10.0.0.1");
      expect(blocked.allowed).toBe(false);

      // windowMs 後にリセット
      vi.advanceTimersByTime(60001);

      const afterReset = limiter.check("10.0.0.1");
      expect(afterReset.allowed).toBe(true);
    });

    it("異なる IP は独立してカウントされる", () => {
      const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 1 });

      limiter.check("10.0.0.1");
      const blocked = limiter.check("10.0.0.1");
      expect(blocked.allowed).toBe(false);

      // 別の IP は影響を受けない
      const otherIp = limiter.check("10.0.0.2");
      expect(otherIp.allowed).toBe(true);
    });
  });

  describe("eviction（MAX_RATE_LIMIT_ENTRIES 超過）", () => {
    it("100,000 エントリ超過後も新規 IP が許可される（eviction 動作確認）", () => {
      const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 30 });

      // 100,000 ユニーク IP を追加して上限に達する
      for (let i = 0; i < 100_000; i++) {
        limiter.check(`ip-${i}`);
      }

      // 上限超過後も新規 IP が許可される（eviction が機能していれば受け付ける）
      const result = limiter.check("overflow-new-ip");
      expect(result.allowed).toBe(true);
    });

    it("100,000 エントリ超過後に最古の IP が evict されてカウントがリセットされる", () => {
      const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 5 });

      // ip-0 を maxRequests 回使って上限に達する
      for (let i = 0; i < 5; i++) {
        limiter.check("ip-0");
      }
      // ip-0 はこの時点でブロック状態
      expect(limiter.check("ip-0").allowed).toBe(false);

      // ip-1 〜 ip-99,999 を追加して ip-0 を最古エントリとして evict させる
      for (let i = 1; i < 100_000; i++) {
        limiter.check(`ip-${i}`);
      }

      // 100,000 エントリ目の追加で ip-0 が evict される
      limiter.check("trigger-eviction-ip");

      // ip-0 は evict されてバケットが消えているため、再び count=1 から開始（許可される）
      const resultAfterEviction = limiter.check("ip-0");
      expect(resultAfterEviction.allowed).toBe(true);
    });
  });

  describe("cleanup()", () => {
    it("windowMs 経過後に cleanup() を呼ぶと期限切れエントリが削除される", () => {
      const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 10 });

      // 2 つの IP を追加
      limiter.check("10.0.0.1");
      limiter.check("10.0.0.2");

      // windowMs 経過後に cleanup
      vi.advanceTimersByTime(1001);
      limiter.cleanup();

      // cleanup 後: 期限切れエントリが削除されたため、同 IP が count=1 から再開（新規エントリ）
      const result1 = limiter.check("10.0.0.1");
      expect(result1.allowed).toBe(true);

      const result2 = limiter.check("10.0.0.2");
      expect(result2.allowed).toBe(true);
    });

    it("windowMs 未経過のエントリは cleanup() で削除されない", () => {
      const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 1 });

      limiter.check("10.0.0.1");
      limiter.check("10.0.0.1"); // 2回目: ブロック

      // windowMs 未経過（30秒しか経っていない）
      vi.advanceTimersByTime(30000);
      limiter.cleanup();

      // エントリが残っているため、まだブロック状態
      const result = limiter.check("10.0.0.1");
      expect(result.allowed).toBe(false);
    });
  });
});
