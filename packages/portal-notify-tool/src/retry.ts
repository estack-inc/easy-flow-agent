// 指数バックオフによる retry ヘルパ。
//
// 設計方針：
//   - sleep を依存性注入（第 3 引数）にすることでテストが仮想時間で完結する。
//     setTimeout を直接掴むと vitest fake timer との結合が脆くなり、CI で flaky になる。
//   - 「retry すべきか」の判定は呼び出し側で行い、本ヘルパは値の `retry: bool` フラグを
//     見るだけ。Error を直接 throw された場合は分類済みエラーとみなし、retry せず即伝播。
//   - jitter は ±25% で固定（thundering herd 緩和に十分）。jitter 範囲も外部設定にする
//     設計余地はあるが、現状の portal 利用形態では過剰なので固定値とする。

/**
 * retryWithBackoff の fn が返す結果型。
 * - `retry: false` なら成功で即終了し value を返す
 * - `retry: true` なら delays[i] だけ sleep してから再試行
 * - 全 retry 後も `retry: true` のままなら最後の error を throw する
 */
export type RetryStep<T> =
  | { retry: false; value: T }
  | { retry: true; error: Error };

/**
 * 指数バックオフで fn を試行する。
 *
 * @param fn 試行する非同期関数。retry すべきかどうかを返す
 * @param delaysMs 各 retry 前の sleep ミリ秒。空配列なら retry しない
 * @param sleep ミリ秒だけ待機する関数（DI）
 * @returns fn が retry: false で返した value
 * @throws fn が直接 throw したエラー、または retry を尽くした最後の error
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<RetryStep<T>>,
  delaysMs: number[],
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  let lastError: Error | undefined;

  // 試行回数 = 1（初回）+ delaysMs.length（retry）
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    if (attempt > 0) {
      await sleep(delaysMs[attempt - 1]);
    }
    const result = await fn();
    if (!result.retry) {
      return result.value;
    }
    lastError = result.error;
  }

  // delaysMs が空 + 初回 retry: true の場合に備えて lastError は必ず存在する
  throw lastError ?? new Error("retry exhausted");
}

/**
 * delay に ±25% の jitter を加える。負数 / 0 は 0 にクランプ。
 *
 * 用途：複数 instance が同じバックオフ列で portal にバースト retry するのを避ける。
 */
export function addJitter(delayMs: number): number {
  if (delayMs <= 0) return 0;
  const jitter = (Math.random() - 0.5) * 0.5; // [-0.25, +0.25)
  return Math.max(0, Math.round(delayMs * (1 + jitter)));
}
