import { ProviderError } from '../../application/errors.ts';

export interface RetryOptions {
  /** Provider name used in errors. */
  readonly provider: string;
  readonly timeoutMs: number;
  /** Extra attempts after the first. */
  readonly retries: number;
  readonly baseDelayMs: number;
  /** Cap for any single wait, including a server's Retry-After. */
  readonly maxDelayMs: number;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Retry 429s (default true). Off for providers whose limits are per minute/hour/day windows. */
  readonly retryOn429?: boolean;
}

const RETRYABLE = new Set([429, 502, 503, 504]);

export const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Seconds from a Retry-After header (delta-seconds or HTTP date), if present. */
export function retryAfterSeconds(res: Response, now = Date.now()): number | undefined {
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.max(0, n);
  const t = Date.parse(h);
  return Number.isNaN(t) ? undefined : Math.max(0, (t - now) / 1000);
}

/**
 * fetch with a per-attempt timeout and retries (exponential backoff, honouring
 * Retry-After) on network errors, timeouts and 429/502/503/504. Returns the final
 * Response whatever its status — callers map statuses to domain errors. Throws
 * ProviderError('timeout' | 'unavailable') only if no response was obtained.
 * A caller abort is rethrown as-is, never retried.
 */
export async function fetchWithRetry(url: string, init: RequestInit, opts: RetryOptions): Promise<Response> {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? abortableSleep;
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    const timeout = AbortSignal.timeout(opts.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let res: Response | undefined;
    try {
      res = await doFetch(url, { ...init, signal });
    } catch (err) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      lastError = err;
    }

    const last = attempt === opts.retries;
    const retryable = res ? RETRYABLE.has(res.status) && !(res.status === 429 && opts.retryOn429 === false) : true;
    if (res && (!retryable || last)) return res;

    if (!last) {
      const backoff = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt);
      const server = res ? retryAfterSeconds(res) : undefined;
      const wait = server === undefined ? backoff : Math.min(opts.maxDelayMs, server * 1000);
      await res?.body?.cancel();
      await sleep(wait, opts.signal);
    }
  }

  const timedOut = lastError instanceof DOMException && lastError.name === 'TimeoutError';
  throw new ProviderError(opts.provider, timedOut ? 'timeout' : 'unavailable', timedOut ? 'request timed out' : 'network error', {
    cause: lastError,
  });
}
