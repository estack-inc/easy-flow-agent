type BucketEntry = {
  count: number;
  resetAt: number;
};

export type RateLimiterConfig = {
  windowMs: number;
  maxRequests: number;
};

// 大量ユニーク IP によるメモリ枯渇（DoS）を防ぐエントリ数上限
const MAX_RATE_LIMIT_ENTRIES = 100_000;

export class RateLimiter {
  private readonly buckets = new Map<string, BucketEntry>();
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(config: RateLimiterConfig) {
    this.windowMs = config.windowMs;
    this.maxRequests = config.maxRequests;
  }

  check(ip: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const now = Date.now();
    let entry = this.buckets.get(ip);

    if (!entry || now >= entry.resetAt) {
      // 新規 IP: エントリ上限に達している場合は FIFO で最古挿入エントリを evict して収容
      // （Map は挿入順でイテレートされるため先頭 = 最古。永続的にブロックされる IP を防ぐ）
      if (!entry && this.buckets.size >= MAX_RATE_LIMIT_ENTRIES) {
        const firstKey = this.buckets.keys().next().value;
        if (firstKey !== undefined) this.buckets.delete(firstKey);
      }
      entry = { count: 1, resetAt: now + this.windowMs };
      this.buckets.set(ip, entry);
      return { allowed: true };
    }

    entry.count++;
    if (entry.count > this.maxRequests) {
      return { allowed: false, retryAfterMs: entry.resetAt - now };
    }

    return { allowed: true };
  }

  cleanup(): void {
    const now = Date.now();
    for (const [ip, entry] of this.buckets) {
      if (now >= entry.resetAt) this.buckets.delete(ip);
    }
  }
}
