/**
 * Incoming request limiter: at most `limit` requests per `windowMs` per key (client
 * IP). Never waits — callers reject with 429. In-memory per function instance, so it
 * is best-effort protection of upstream quotas, not a security boundary.
 */
export class WindowLimiter {
  private readonly hits = new Map<string, { start: number; count: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  check(key: string): { ok: true } | { ok: false; retryAfterS: number } {
    const t = this.now();
    const h = this.hits.get(key);
    if (!h || t - h.start >= this.windowMs) {
      this.hits.set(key, { start: t, count: 1 });
      if (this.hits.size > 10_000) this.prune(t);
      return { ok: true };
    }
    if (h.count >= this.limit) return { ok: false, retryAfterS: Math.ceil((h.start + this.windowMs - t) / 1000) };
    h.count++;
    return { ok: true };
  }

  private prune(t: number): void {
    for (const [k, h] of this.hits) if (t - h.start >= this.windowMs) this.hits.delete(k);
  }
}
