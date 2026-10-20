import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../../test/helpers/http.ts';
import { ATHENS, offset, walk } from '../../test/helpers/geometry.ts';
import { ENGINE_CONFIG } from '../domain/config/engineConfig.ts';
import { demCell, demCellCentre, demCellKey } from '../domain/elevation/demCell.ts';
import { distance } from '../domain/geo/distance.ts';
import type { LngLat } from '../domain/geo/types.ts';
import { createCellCachedElevationSource, tileKeyOf } from './elevation/cellCachedElevationSource.ts';
import { ProviderError } from './errors.ts';
import { cachedGeocoder, geocodeCacheKey } from './geocoding/cachedGeocoder.ts';
import { geocodeWithFallback } from './geocoding/geocodeWithFallback.ts';
import type { DemTileStore, GeocodeResult, Geocoder, JsonCache, RoutedShape, RoutingProvider } from './ports.ts';
import { routeThroughWaypoints } from './routing/routeThroughWaypoints.ts';

// ------------------------------------------------------------------ routeThroughWaypoints

/** Fake provider: straight lines between points, 2 vertices per leg, with via/arrive instructions. */
function straightProvider(maxPoints: number): RoutingProvider & { calls: LngLat[][] } {
  const calls: LngLat[][] = [];
  return {
    name: 'fake',
    profile: 'foot',
    maxPointsPerRequest: maxPoints,
    calls,
    async route(points) {
      calls.push([...points]);
      const geometry: LngLat[] = [points[0]!];
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1]!;
        const b = points[i]!;
        geometry.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], b);
      }
      const last = geometry.length - 1;
      const shape: RoutedShape = {
        geometry,
        attributes: { roadClass: [{ from: 0, to: last, value: 'residential' }] },
        waypoints: points.map((p, i) => ({ position: p, geometryIndex: i * 2 })),
        instructions: [
          ...points.slice(1, -1).map((_, i) => ({ turn: 'via' as const, text: 'via', streetName: '', distanceM: 0, from: (i + 1) * 2, to: (i + 1) * 2 })),
          { turn: 'arrive', text: 'Arrive', streetName: '', distanceM: 0, from: last, to: last },
        ],
      };
      return shape;
    },
  };
}

describe('routeThroughWaypoints', () => {
  const wps = Array.from({ length: 6 }, (_, i) => offset(ATHENS, i * 200, 0));

  it('chunks into overlapping requests within the provider limit', async () => {
    const p = straightProvider(3);
    await routeThroughWaypoints(p, wps);
    expect(p.calls.map((c) => c.length)).toEqual([3, 3, 2]);
    expect(p.calls[1]![0]).toEqual(p.calls[0]![2]);
    expect(p.calls[2]![0]).toEqual(p.calls[1]![2]);
  });

  it('joins geometry, waypoints, spans and instructions as one route', async () => {
    const r = await routeThroughWaypoints(straightProvider(3), wps);
    expect(r.geometry).toHaveLength(11);
    expect(r.waypoints.map((w) => w.geometryIndex)).toEqual([0, 2, 4, 6, 8, 10]);
    r.waypoints.forEach((w, i) => expect(distance(r.geometry[w.geometryIndex]!, wps[i]!)).toBeLessThan(0.01));
    expect(r.instructions.filter((i) => i.turn === 'arrive')).toHaveLength(1);
    expect(r.instructions.filter((i) => i.turn === 'via').map((i) => i.from)).toEqual([2, 4, 6, 8]);
    expect(r.attributes.roadClass?.at(-1)).toEqual({ from: 8, to: 10, value: 'residential' });
  });

  it('a single request when within the limit; rejects < 2 waypoints', async () => {
    const p = straightProvider(5);
    await routeThroughWaypoints(p, wps.slice(0, 4));
    expect(p.calls).toHaveLength(1);
    await expect(routeThroughWaypoints(p, [ATHENS])).rejects.toThrow(RangeError);
  });

  it('propagates provider errors', async () => {
    const p = straightProvider(5);
    p.route = () => Promise.reject(new ProviderError('fake', 'point_not_routable', 'nope', { pointIndex: 1 }));
    await expect(routeThroughWaypoints(p, wps.slice(0, 2))).rejects.toMatchObject({ code: 'point_not_routable' });
  });
});

// ------------------------------------------------------------------ cell-cached elevation

function memoryTiles(): DemTileStore & { data: Map<string, Record<string, number>>; puts: number } {
  const data = new Map<string, Record<string, number>>();
  const s = {
    data,
    puts: 0,
    get: async (k: string) => data.get(k),
    put: async (k: string, v: Readonly<Record<string, number>>) => {
      s.puts++;
      data.set(k, { ...v });
    },
  };
  return s;
}

describe('createCellCachedElevationSource', () => {
  const grid = ENGINE_CONFIG.dem;
  const line = walk(ATHENS, [[90, 1000]], 10); // 101 points, ~14 cells

  function setup() {
    const tiles = memoryTiles();
    const dem = { name: 'dem', elevations: vi.fn(async (pts: readonly LngLat[]) => pts.map((p) => Math.round(p[0] * 1e4) % 1000)) };
    const logger = silentLogger();
    const source = createCellCachedElevationSource({ dem, tiles, grid, tileSize: 32, logger });
    return { tiles, dem, logger, source };
  }

  it('asks the provider once per distinct cell, at the cell centre', async () => {
    const { dem, source } = setup();
    const out = await source.lookup(line);
    expect(out).toHaveLength(line.length);
    const asked = dem.elevations.mock.calls[0]![0];
    const distinct = new Set(line.map((p) => demCellKey(p, grid)));
    expect(asked).toHaveLength(distinct.size);
    for (const p of asked) expect(p).toEqual(demCellCentre(demCell(p, grid), grid));
    // Points in the same cell get the same value.
    line.forEach((p, i) => expect(out[i]).toBe(out[line.findIndex((q) => demCellKey(q, grid) === demCellKey(p, grid))]));
  });

  it('serves repeat lookups from tiles without calling the provider', async () => {
    const { dem, source, tiles } = setup();
    const first = await source.lookup(line);
    expect(tiles.data.size).toBeGreaterThan(0);
    const second = await source.lookup([...line].reverse());
    expect(second).toEqual([...first].reverse());
    expect(dem.elevations).toHaveBeenCalledTimes(1);
  });

  it('groups cells into tiles', () => {
    expect(tileKeyOf({ row: 45555, col: 28503 }, 32)).toBe('1423:890');
    expect(tileKeyOf({ row: -1, col: -33 }, 32)).toBe('-1:-2');
  });

  it('logs but tolerates tile write failures; provider failures propagate', async () => {
    const { dem, logger, tiles } = setup();
    tiles.put = () => Promise.reject(new Error('blobs down'));
    const source = createCellCachedElevationSource({ dem, tiles, grid, tileSize: 32, logger });
    await expect(source.lookup(line)).resolves.toHaveLength(line.length);
    expect(logger.events.some((e) => e.event === 'dem_tile_write_failed')).toBe(true);

    dem.elevations.mockRejectedValueOnce(new ProviderError('dem', 'rate_limited', '429'));
    const fresh = createCellCachedElevationSource({ dem, tiles: memoryTiles(), grid, tileSize: 32, logger });
    await expect(fresh.lookup(line)).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('rejects a provider answer of the wrong length', async () => {
    const tiles = memoryTiles();
    const dem = { name: 'dem', elevations: async () => [1] };
    const s = createCellCachedElevationSource({ dem, tiles, grid, tileSize: 32, logger: silentLogger() });
    await expect(s.lookup(line)).rejects.toThrow(/returned 1 values/);
  });
});

// ------------------------------------------------------------------ geocoding

const result = (name: string): GeocodeResult => ({ name, label: name, position: [23.75, 37.96], kind: 'street' });
const geocoder = (name: string, impl: Geocoder['search']): Geocoder => ({ name, search: impl });

describe('geocodeWithFallback', () => {
  const q = { text: 'Μεσολογγίου', limit: 5 };
  it('uses the primary when it has results', async () => {
    const out = await geocodeWithFallback(geocoder('a', async () => [result('A')]), geocoder('b', async () => [result('B')]), q);
    expect(out).toEqual({ results: [result('A')], provider: 'a' });
  });
  it('falls back explicitly on no results or provider error', async () => {
    const b = geocoder('b', async () => [result('B')]);
    expect((await geocodeWithFallback(geocoder('a', async () => []), b, q)).fallback).toEqual({ from: 'a', reason: 'no_results' });
    const failing = geocoder('a', () => Promise.reject(new ProviderError('a', 'unavailable', 'down')));
    expect(await geocodeWithFallback(failing, b, q)).toEqual({ results: [result('B')], provider: 'b', fallback: { from: 'a', reason: 'provider_error' } });
  });
  it('throws the primary error when both fail; never masks programming errors', async () => {
    const e1 = new ProviderError('a', 'unavailable', 'down');
    await expect(
      geocodeWithFallback(geocoder('a', () => Promise.reject(e1)), geocoder('b', () => Promise.reject(new ProviderError('b', 'unavailable', 'x'))), q),
    ).rejects.toBe(e1);
    await expect(geocodeWithFallback(geocoder('a', () => Promise.reject(new TypeError('bug'))), geocoder('b', async () => []), q)).rejects.toThrow(TypeError);
  });
});

describe('cachedGeocoder', () => {
  function memCache(): JsonCache & { store: Map<string, unknown> } {
    const store = new Map<string, unknown>();
    return { store, get: async (k) => store.get(k) as never, set: async (k, v) => void store.set(k, v) };
  }
  it('caches results including empty ones, keyed by normalised query', async () => {
    const inner = { name: 'n', search: vi.fn(async () => [] as GeocodeResult[]) };
    const g = cachedGeocoder(inner, memCache(), silentLogger());
    await g.search({ text: '  Μεσολογγίου   49 ', limit: 5 });
    await g.search({ text: 'μεσολογγίου 49', limit: 5 });
    expect(inner.search).toHaveBeenCalledTimes(1);
    expect(geocodeCacheKey('n', { text: 'A  b', near: [23.751, 37.962], limit: 3 })).toBe('geocode/v1/n/a%20b/23.75,37.96/3/-');
  });
  it('bypasses (and logs) a failing cache', async () => {
    const logger = silentLogger();
    const broken: JsonCache = { get: () => Promise.reject(new Error('r')), set: () => Promise.reject(new Error('w')) };
    const g = cachedGeocoder(geocoder('n', async () => [result('A')]), broken, logger);
    expect(await g.search({ text: 'x', limit: 1 })).toEqual([result('A')]);
    expect(logger.events.map((e) => e.event)).toEqual(['geocode_cache_read_failed', 'geocode_cache_write_failed']);
  });
});
