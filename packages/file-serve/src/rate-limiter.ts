type BucketEntry = {
  count: number;
  resetAt: number;
};

export type RateLimiterConfig = {
  windowMs: number;
  maxRequests: number;
};

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
