// retry.ts: 指数バックオフ + jitter ヘルパのテスト。
//
// retryWithBackoff(fn, delaysMs, sleepFn) は与えられた fn を最大 delaysMs.length+1 回
// 試行する。fn が `{ retry: true, error }` を返したら次の delay 後に再試行、
// `{ retry: false, value }` を返したら即座に成功で終了する。throw された Error は
// retry せず即座に上位へ伝播する（caller がエラー分類済みである前提）。
//
// sleep は外注（依存性注入）にしてテストで仮想時間にする。
import { describe, expect, it, vi } from "vitest";
import { addJitter, retryWithBackoff } from "./retry.js";

describe("retryWithBackoff", () => {
  it("初回成功なら sleep は呼ばれない", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fn = vi.fn(async () => ({ retry: false as const, value: "ok" }));
    const result = await retryWithBackoff(fn, [100, 200], sleep);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retry: true が続けば delaysMs 全件分 sleep して fn を delaysMs.length+1 回呼ぶ", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fn = vi.fn(async () => ({
      retry: true as const,
      error: new Error("transient"),
    }));
    await expect(
      retryWithBackoff(fn, [10, 20, 30], sleep),
    ).rejects.toThrow("transient");
    expect(fn).toHaveBeenCalledTimes(4); // 初回 + 3 回 retry
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 10);
    expect(sleep).toHaveBeenNthCalledWith(2, 20);
    expect(sleep).toHaveBeenNthCalledWith(3, 30);
  });

  it("途中で retry: false に切り替われば即終了", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    let count = 0;
    const fn = vi.fn(async () => {
      count++;
      if (count < 3) {
        return { retry: true as const, error: new Error("transient") };
      }
      return { retry: false as const, value: 42 };
    });
    const result = await retryWithBackoff(fn, [10, 20, 30, 40], sleep);
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("delaysMs が空配列なら 1 回のみ試行で retry しない", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fn = vi.fn(async () => ({
      retry: true as const,
      error: new Error("once"),
    }));
    await expect(retryWithBackoff(fn, [], sleep)).rejects.toThrow("once");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("fn が直接 throw した場合は retry せず即伝播", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fn = vi.fn(async () => {
      throw new Error("fatal");
    });
    await expect(
      retryWithBackoff(fn, [10, 20], sleep),
    ).rejects.toThrow("fatal");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("addJitter", () => {
  it("delay の ±25% 範囲に収まる", () => {
    const delay = 1000;
    for (let i = 0; i < 100; i++) {
      const jittered = addJitter(delay);
      expect(jittered).toBeGreaterThanOrEqual(750);
      expect(jittered).toBeLessThanOrEqual(1250);
    }
  });

  it("delay 0 は 0 を返す", () => {
    expect(addJitter(0)).toBe(0);
  });

  it("負の delay は 0 にクランプ", () => {
    expect(addJitter(-100)).toBe(0);
  });
});
