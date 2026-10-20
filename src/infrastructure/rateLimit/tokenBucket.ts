import { abortableSleep } from '../http/fetchWithRetry.ts';

export interface TokenBucketOptions {
  /** Maximum burst. */
  readonly capacity: number;
  /** Tokens added per `perMs`. */
  readonly refill: number;
  readonly perMs: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Outgoing pacing. `take(n)` waits until n tokens are available; callers are served
 * strictly in arrival order. Per-process only: separate serverless instances do not
 * share a bucket (acceptable for single-user personal use; see CLAUDE.md).
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private queue: Promise<void> = Promise.resolve();
  private readonly opts: TokenBucketOptions;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(opts: TokenBucketOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? abortableSleep;
    this.tokens = opts.capacity;
    this.last = this.now();
  }

  take(n: number, signal?: AbortSignal): Promise<void> {
    if (n > this.opts.capacity) {
      return Promise.reject(new RangeError(`cannot take ${n} tokens from a bucket of ${this.opts.capacity}`));
    }
    const run = this.queue.then(() => this.waitFor(n, signal));
    // Keep the chain alive even if this caller aborts.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private refillNow(): void {
    const t = this.now();
    this.tokens = Math.min(this.opts.capacity, this.tokens + ((t - this.last) * this.opts.refill) / this.opts.perMs);
    this.last = t;
  }

  private async waitFor(n: number, signal?: AbortSignal): Promise<void> {
    this.refillNow();
    while (this.tokens < n) {
      const deficit = n - this.tokens;
      await this.sleep(Math.ceil((deficit * this.opts.perMs) / this.opts.refill), signal);
      this.refillNow();
    }
    this.tokens -= n;
  }
}
