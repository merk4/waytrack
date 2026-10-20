import { readFileSync } from 'node:fs';
import { TokenBucket } from '../../src/infrastructure/rateLimit/tokenBucket.ts';

export interface RecordedCall {
  url: string;
  init: RequestInit;
}

type Responder = (url: string, init: RequestInit) => Response | Promise<Response>;

/** fetch stand-in that replays responders in order and records calls. */
export function fakeFetch(...responders: Responder[]): typeof fetch & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const r = responders[Math.min(calls.length - 1, responders.length - 1)];
    if (!r) throw new Error('fakeFetch: no responder');
    return r(url, init);
  }) as typeof fetch & { calls: RecordedCall[] };
  f.calls = calls;
  return f;
}

export const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/** A captured provider fixture: `{ status, body }` from scripts/capture-provider-fixtures.ts. */
export function providerFixture(name: string): { status: number; body: unknown } {
  return JSON.parse(readFileSync(new URL(`../fixtures/providers/${name}.json`, import.meta.url), 'utf8'));
}

/** A bucket that never waits but records what was taken. */
export function recordingBucket(): TokenBucket & { taken: number[] } {
  const b = new TokenBucket({ capacity: 1e9, refill: 1e9, perMs: 1 }) as TokenBucket & { taken: number[] };
  b.taken = [];
  const take = b.take.bind(b);
  b.take = (n, signal) => {
    b.taken.push(n);
    return take(n, signal);
  };
  return b;
}

export const silentLogger = () => {
  const events: { level: string; event: string; data?: Record<string, unknown> }[] = [];
  return {
    events,
    info: (event: string, data?: Record<string, unknown>) => void events.push({ level: 'info', event, ...(data ? { data } : {}) }),
    warn: (event: string, data?: Record<string, unknown>) => void events.push({ level: 'warn', event, ...(data ? { data } : {}) }),
    error: (event: string, data?: Record<string, unknown>) => void events.push({ level: 'error', event, ...(data ? { data } : {}) }),
  };
};
