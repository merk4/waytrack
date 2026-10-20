import { describe, expect, it, vi } from 'vitest';
import { fakeFetch, jsonResponse, silentLogger } from '../../test/helpers/http.ts';
import { ProviderError } from '../application/errors.ts';
import { createDemTileStore, createJsonCache, type BlobStoreLike } from './cache/blobStores.ts';
import { MemoryLru } from './cache/memoryLru.ts';
import { fetchWithRetry, retryAfterSeconds } from './http/fetchWithRetry.ts';
import { redact } from './logging/logger.ts';
import { TokenBucket } from './rateLimit/tokenBucket.ts';
import { WindowLimiter } from './rateLimit/windowLimiter.ts';

describe('fetchWithRetry', () => {
  const opts = (over: object = {}) => {
    const sleeps: number[] = [];
    return {
      sleeps,
      o: { provider: 'p', timeoutMs: 1000, retries: 2, baseDelayMs: 100, maxDelayMs: 1000, sleep: async (ms: number) => void sleeps.push(ms), ...over },
    };
  };

  it('retries 503 with exponential backoff, then returns the success', async () => {
    const f = fakeFetch(() => jsonResponse({}, 503), () => jsonResponse({}, 503), () => jsonResponse({ ok: 1 }));
    const { o, sleeps } = opts({ fetchImpl: f });
    const res = await fetchWithRetry('https://x', {}, o);
    expect(res.status).toBe(200);
    expect(sleeps).toEqual([100, 200]);
  });

  it('honours Retry-After, capped by maxDelayMs', async () => {
    const f = fakeFetch(() => jsonResponse({}, 429, { 'Retry-After': '30' }), () => jsonResponse({}));
    const { o, sleeps } = opts({ fetchImpl: f });
    await fetchWithRetry('https://x', {}, o);
    expect(sleeps).toEqual([1000]);
  });

  it('does not retry 4xx (other than 429) and returns the final retryable response', async () => {
    const f400 = fakeFetch(() => jsonResponse({}, 400));
    expect((await fetchWithRetry('https://x', {}, opts({ fetchImpl: f400 }).o)).status).toBe(400);
    expect(f400.calls).toHaveLength(1);
    const f503 = fakeFetch(() => jsonResponse({}, 503));
    expect((await fetchWithRetry('https://x', {}, opts({ fetchImpl: f503 }).o)).status).toBe(503);
    expect(f503.calls).toHaveLength(3);
  });

  it('network failure → ProviderError unavailable; timeout → timeout', async () => {
    const net = fakeFetch(() => Promise.reject(new TypeError('fetch failed')));
    await expect(fetchWithRetry('https://x', {}, opts({ fetchImpl: net }).o)).rejects.toMatchObject({ code: 'unavailable' });
    const slow = fakeFetch(() => Promise.reject(new DOMException('t', 'TimeoutError')));
    await expect(fetchWithRetry('https://x', {}, opts({ fetchImpl: slow }).o)).rejects.toBeInstanceOf(ProviderError);
    await expect(fetchWithRetry('https://x', {}, opts({ fetchImpl: slow }).o)).rejects.toMatchObject({ code: 'timeout' });
  });

  it('a caller abort is rethrown immediately, never retried', async () => {
    const ctrl = new AbortController();
    const f = fakeFetch(() => {
      ctrl.abort(new DOMException('stop', 'AbortError'));
      return Promise.reject(new DOMException('stop', 'AbortError'));
    });
    await expect(fetchWithRetry('https://x', {}, opts({ fetchImpl: f, signal: ctrl.signal }).o)).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.calls).toHaveLength(1);
  });

  it('can be told not to retry 429s (window-based limits)', async () => {
    const f = fakeFetch(() => jsonResponse({}, 429), () => jsonResponse({}));
    const res = await fetchWithRetry('https://x', {}, opts({ fetchImpl: f, retryOn429: false }).o);
    expect(res.status).toBe(429);
    expect(f.calls).toHaveLength(1);
  });

  it('parses Retry-After seconds and dates', () => {
    expect(retryAfterSeconds(new Response(null, { headers: { 'Retry-After': '12' } }))).toBe(12);
    const now = Date.parse('2026-10-19T10:00:00Z');
    expect(retryAfterSeconds(new Response(null, { headers: { 'Retry-After': 'Mon, 19 Oct 2026 10:00:30 GMT' } }), now)).toBe(30);
    expect(retryAfterSeconds(new Response(null))).toBeUndefined();
  });
});

describe('TokenBucket', () => {
  function clocked(capacity: number, refill: number, perMs: number) {
    let t = 0;
    const sleeps: number[] = [];
    const b = new TokenBucket({ capacity, refill, perMs, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } });
    return { b, sleeps, advance: (ms: number) => (t += ms) };
  }

  it('allows a burst up to capacity, then waits for refill', async () => {
    const { b, sleeps } = clocked(2, 1, 1000);
    await b.take(1);
    await b.take(1);
    expect(sleeps).toEqual([]);
    await b.take(1);
    expect(sleeps).toEqual([1000]);
  });

  it('serves callers in order and rejects requests above capacity', async () => {
    const { b } = clocked(1, 1, 1000);
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((i) => b.take(1).then(() => order.push(i))));
    expect(order).toEqual([1, 2, 3]);
    await expect(b.take(5)).rejects.toThrow(RangeError);
  });
});

describe('WindowLimiter', () => {
  it('allows `limit` per window per key', () => {
    let t = 0;
    const l = new WindowLimiter(2, 60_000, () => t);
    expect(l.check('a').ok).toBe(true);
    expect(l.check('a').ok).toBe(true);
    expect(l.check('a')).toEqual({ ok: false, retryAfterS: 60 });
    expect(l.check('b').ok).toBe(true);
    t = 60_000;
    expect(l.check('a').ok).toBe(true);
  });
});

describe('MemoryLru', () => {
  it('evicts least recently used and expires entries', () => {
    let t = 0;
    const c = new MemoryLru<number>(2, () => t);
    c.set('a', 1);
    c.set('b', 2);
    c.get('a');
    c.set('c', 3);
    expect([c.get('a'), c.get('b'), c.get('c')]).toEqual([1, undefined, 3]);
    c.set('d', 4, 100);
    t = 100;
    expect(c.get('d')).toBeUndefined();
  });
});

function fakeBlobs(): BlobStoreLike & { data: Map<string, { value: unknown; metadata: Record<string, unknown> }> } {
  const data = new Map<string, { value: unknown; metadata: Record<string, unknown> }>();
  return {
    data,
    get: vi.fn(async (k: string) => data.get(k)?.value ?? null),
    getWithMetadata: async (k) => {
      const e = data.get(k);
      return e ? { data: e.value, metadata: e.metadata } : null;
    },
    setJSON: async (k, value, o) => void data.set(k, { value, metadata: o?.metadata ?? {} }),
    delete: async (k) => void data.delete(k),
  };
}

describe('blob-backed stores', () => {
  it('JSON cache stores expiry in metadata and deletes expired entries', async () => {
    let t = 1_000;
    const blobs = fakeBlobs();
    const cache = createJsonCache(blobs, () => t, 0);
    await cache.set('k', { a: 1 }, 10);
    expect(blobs.data.get('k')!.metadata).toEqual({ expiresAt: 11_000 });
    expect(await cache.get('k')).toEqual({ a: 1 });
    t = 11_000;
    expect(await cache.get('k')).toBeUndefined();
    expect(blobs.data.has('k')).toBe(false);
  });

  it('DEM tiles: memory in front of blobs; corrupt tiles are logged and ignored', async () => {
    const blobs = fakeBlobs();
    const logger = silentLogger();
    const store = createDemTileStore(blobs, logger);
    await store.put('t', { '1:2': 130 });
    expect(await store.get('t')).toEqual({ '1:2': 130 });
    expect(blobs.get).not.toHaveBeenCalled();
    blobs.data.set('bad', { value: { '1:2': 'high' }, metadata: {} });
    expect(await store.get('bad')).toBeUndefined();
    expect(logger.events[0]!.event).toBe('dem_tile_corrupt');
  });
});

describe('redact', () => {
  it('removes credential fields and query parameters', () => {
    expect(
      redact({ url: 'https://graphhopper.com/api/1/route?key=SECRET&x=1', apiKey: 'SECRET', nested: { token: 't', ok: 'fine' } }),
    ).toEqual({ url: 'https://graphhopper.com/api/1/route?key=[REDACTED]&x=1', apiKey: '[REDACTED]', nested: { token: '[REDACTED]', ok: 'fine' } });
  });
});
