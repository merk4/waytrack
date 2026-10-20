import { writeArrayBuffer } from 'geotiff';
import { describe, expect, it } from 'vitest';
import { fakeFetch } from '../../../../test/helpers/http.ts';
import { createCopernicusAwsDem, decodeTile, sampleTile, tileName, type DemTile } from './copernicusAwsDem.ts';

/** A tiny GeoTIFF shaped like a GLO-90 tile: 1/1200° pixels, origin at the tile's NW corner. */
function syntheticTiff(west: number, north: number, size: number, value: (row: number, col: number) => number): ArrayBuffer {
  // Float32Array: the writer only honours float32 tags for typed input (a plain array is mis-encoded).
  const values = Float32Array.from({ length: size * size }, (_, i) => value(Math.floor(i / size), i % size));
  return writeArrayBuffer(values, {
    width: size,
    height: size,
    ModelPixelScale: [1 / 1200, 1 / 1200, 0],
    ModelTiepoint: [0, 0, 0, west, north, 0],
    GeographicTypeGeoKey: 4326,
    GTModelTypeGeoKey: 2,
    GTRasterTypeGeoKey: 2,
    SampleFormat: [3],
    BitsPerSample: [32],
  }) as ArrayBuffer;
}

describe('tileName', () => {
  it.each([
    [[23.75, 37.96], 'Copernicus_DSM_COG_30_N37_00_E023_00_DEM'],
    [[-0.5, 51.5], 'Copernicus_DSM_COG_30_N51_00_W001_00_DEM'],
    [[151.2, -33.9], 'Copernicus_DSM_COG_30_S34_00_E151_00_DEM'],
    [[-124.5, 49.0], 'Copernicus_DSM_COG_30_N49_00_W125_00_DEM'],
  ] as const)('%j → %s', (p, name) => {
    expect(tileName(p)).toBe(name);
  });
});

describe('sampleTile', () => {
  // 3×3 tile at 1/1200°, NW corner at (23, 38): pixel (r, c) = 100 + 10r + c.
  const tile: DemTile = { raster: [100, 101, 102, 110, 111, 112, 120, 121, 122], width: 3, height: 3, west: 23, north: 38, resLng: 1 / 1200, resLat: 1 / 1200 };
  it('returns the pixel containing the point (the mapping verified against Open-Meteo)', () => {
    expect(sampleTile(tile, [23 + 0.5 / 1200, 38 - 0.5 / 1200])).toBe(100);
    expect(sampleTile(tile, [23 + 2.5 / 1200, 38 - 1.5 / 1200])).toBe(112);
    expect(sampleTile(tile, [23 + 1.01 / 1200, 38 - 2.99 / 1200])).toBe(121);
  });
  it('rounds to whole metres and rejects points outside the tile', () => {
    expect(sampleTile({ ...tile, raster: [130.6, 0, 0, 0, 0, 0, 0, 0, 0] }, [23.0001, 37.9999])).toBe(131);
    expect(() => sampleTile(tile, [22.99, 37.99])).toThrow();
  });
});

describe('decodeTile', () => {
  it('reads origin, resolution and values from a GeoTIFF', async () => {
    const t = await decodeTile(syntheticTiff(23, 38, 4, (r, c) => 100 + 10 * r + c));
    expect([t.west, t.north, t.width, t.height]).toEqual([23, 38, 4, 4]);
    expect(t.resLng).toBeCloseTo(1 / 1200, 12);
    expect(t.resLat).toBeCloseTo(1 / 1200, 12);
    expect(sampleTile(t, [23 + 3.5 / 1200, 38 - 2.5 / 1200])).toBe(123);
  });
});

describe('createCopernicusAwsDem', () => {
  const tiff = syntheticTiff(23, 38, 8, (r, c) => 100 + r + c);

  it('downloads each tile once, samples many points, caches across calls', async () => {
    const fetchImpl = fakeFetch(() => new Response(tiff));
    const dem = createCopernicusAwsDem({ fetchImpl, baseUrl: 'https://dem.test' });
    const pts = [[23 + 0.5 / 1200, 38 - 0.5 / 1200], [23 + 7.5 / 1200, 38 - 7.5 / 1200]] as const;
    expect(await dem.elevations(pts)).toEqual([100, 114]);
    expect(await dem.elevations([pts[1]])).toEqual([114]);
    expect(fetchImpl.calls.map((c) => c.url)).toEqual([
      'https://dem.test/Copernicus_DSM_COG_30_N37_00_E023_00_DEM/Copernicus_DSM_COG_30_N37_00_E023_00_DEM.tif',
    ]);
  });

  it('treats a missing tile (404, open sea — verified) as 0 m', async () => {
    const dem = createCopernicusAwsDem({ fetchImpl: fakeFetch(() => new Response('NoSuchKey', { status: 404 })), baseUrl: 'https://dem.test' });
    expect(await dem.elevations([[18.5, 35.5]])).toEqual([0]);
  });

  it('maps server errors and corrupt tiles to ProviderErrors, and retries after a failure', async () => {
    const down = fakeFetch(() => new Response('', { status: 500 }));
    await expect(createCopernicusAwsDem({ fetchImpl: down, baseUrl: 'https://dem.test' }).elevations([[23.5, 37.5]])).rejects.toMatchObject({ code: 'unavailable' });

    const corrupt = createCopernicusAwsDem({ fetchImpl: fakeFetch(() => new Response('not a tiff')), baseUrl: 'https://dem.test' });
    await expect(corrupt.elevations([[23.5, 37.5]])).rejects.toMatchObject({ code: 'bad_response' });

    let first = true;
    const flaky = fakeFetch(() => {
      if (first) {
        first = false;
        return new Response('', { status: 403 });
      }
      return new Response(tiff);
    });
    const dem = createCopernicusAwsDem({ fetchImpl: flaky, baseUrl: 'https://dem.test' });
    await expect(dem.elevations([[23 + 0.5 / 1200, 38 - 0.5 / 1200]])).rejects.toMatchObject({ code: 'unavailable', status: 403 });
    expect(await dem.elevations([[23 + 0.5 / 1200, 38 - 0.5 / 1200]])).toEqual([100]);
  }, 20_000);
});
