import { describe, expect, it } from 'vitest';
import { ATHENS, makeRoute, walk } from '../../../test/helpers/geometry.ts';
import type { ElevationSource } from '../../domain/elevation/source.ts';
import { ProviderError } from '../errors.ts';
import { analyseWithFallback } from './analyseWithFallback.ts';

const geometry = walk(ATHENS, [[90, 2000]], 100);
const route = makeRoute(geometry);
const rising = geometry.map((_, i) => 100 + i); // 1 m per 100 m
const transient = (e: unknown) => e instanceof ProviderError && e.retryable;
const ok: ElevationSource = { lookup: async (pts) => pts.map(() => 120) };
const throttled: ElevationSource = { lookup: () => Promise.reject(new ProviderError('open-meteo', 'rate_limited', 'hourly')) };

describe('analyseWithFallback', () => {
  it('uses the canonical source when it works', async () => {
    const r = await analyseWithFallback(route, ok, rising, transient);
    expect(r.approximate).toBe(false);
    expect(r.analysis.stats.gainM).toBe(0);
  });

  it('falls back to the route vertex elevations when the service is throttled, flagged approximate', async () => {
    const r = await analyseWithFallback(route, throttled, rising, transient);
    expect(r.approximate).toBe(true);
    expect(r.analysis.stats.gainM).toBeCloseTo(20, 0);
  });

  it('does not fall back for non-transient errors, or without vertex data', async () => {
    const bad: ElevationSource = { lookup: () => Promise.reject(new ProviderError('open-meteo', 'invalid_request', 'x')) };
    await expect(analyseWithFallback(route, bad, rising, transient)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(analyseWithFallback(route, throttled, undefined, transient)).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(analyseWithFallback(route, throttled, rising.slice(1), transient)).rejects.toMatchObject({ code: 'rate_limited' });
  });
});
