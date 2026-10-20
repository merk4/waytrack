import { describe, expect, it, vi } from 'vitest';
import { ATHENS, FLAT, makeRoute, walk } from '../../../test/helpers/geometry.ts';
import type { ElevationSource } from '../../domain/elevation/source.ts';
import { analyseRoute, evaluateCandidate, InvalidRouteGeometryError } from './analyseRoute.ts';

const loop = walk(ATHENS, [[0, 2000], [90, 3000], [180, 2000], [270, 3000]]);
const route = makeRoute(loop, { roadClass: [{ from: 0, to: loop.length - 1, value: 'residential' }] });

function constantSource(elevation = 130): ElevationSource & { lookup: ReturnType<typeof vi.fn> } {
  return { lookup: vi.fn(async (pts: readonly unknown[]) => pts.map(() => elevation)) };
}

describe('analyseRoute', () => {
  it('resamples at the configured spacing and derives stats from the profile', async () => {
    const source = constantSource();
    const a = await analyseRoute(route, source);
    const [points] = source.lookup.mock.calls[0]!;
    expect(points).toHaveLength(Math.floor(10_000 / 50) + 1);
    // ±5 m: the test helper scales by origin latitude, which drifts over 2 km.
    expect(a.stats.distanceM).toBeCloseTo(10_000, -1);
    expect(a.stats.gainM).toBe(0);
    expect(a.stats.elevationRangeM).toBe(0);
  });

  it('passes the abort signal through to the elevation source', async () => {
    const source = constantSource();
    const ctrl = new AbortController();
    await analyseRoute(route, source, { signal: ctrl.signal });
    expect(source.lookup.mock.calls[0]![1]).toBe(ctrl.signal);
  });

  it('throws a typed error for structurally invalid geometry without calling the source', async () => {
    const source = constantSource();
    await expect(analyseRoute(makeRoute([ATHENS]), source)).rejects.toBeInstanceOf(InvalidRouteGeometryError);
    expect(source.lookup).not.toHaveBeenCalled();
  });

  it('propagates elevation source failures', async () => {
    const failing: ElevationSource = { lookup: () => Promise.reject(new Error('upstream 429')) };
    await expect(analyseRoute(route, failing)).rejects.toThrow('upstream 429');
  });
});

describe('evaluateCandidate', () => {
  it('scores a valid candidate', async () => {
    const r = await evaluateCandidate(route, { targetDistanceM: 10_000, preferences: FLAT }, constantSource());
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.score.total).toBeGreaterThanOrEqual(0);
  });

  it('never fetches elevation for (or scores) an invalid candidate', async () => {
    const source = constantSource();
    const r = await evaluateCandidate(route, { targetDistanceM: 12_000, preferences: FLAT }, source);
    expect(r.valid).toBe(false);
    expect(r.validation.issues.map((i) => i.code)).toEqual(['distance_out_of_tolerance']);
    expect(source.lookup).not.toHaveBeenCalled();
    expect('score' in r).toBe(false);
  });

  it('reports coordinate issues as an invalid result rather than throwing', async () => {
    const r = await evaluateCandidate(makeRoute([ATHENS, [Number.NaN, 1]]), { targetDistanceM: 1, preferences: FLAT }, constantSource());
    expect(r.valid).toBe(false);
    expect(r.validation.issues[0]!.code).toBe('invalid_coordinate');
  });
});
