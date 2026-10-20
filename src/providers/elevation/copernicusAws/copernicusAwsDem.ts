import { fromArrayBuffer } from 'geotiff';
import { ProviderError } from '../../../application/errors.ts';
import type { DemProvider } from '../../../application/ports.ts';
import type { LngLat } from '../../../domain/geo/types.ts';
import { fetchWithRetry } from '../../../infrastructure/http/fetchWithRetry.ts';
import { MemoryLru } from '../../../infrastructure/cache/memoryLru.ts';

const PROVIDER = 'copernicus-aws';

/**
 * Copernicus DEM GLO-90 read directly from the AWS Open Data registry (public, no key,
 * no quota): one Cloud-Optimised GeoTIFF per 1°×1° tile (≈1–2 MB).
 * Verified 2026-10-19: for all 265 DEM cells of the recorded Vironas run, the value of
 * the pixel containing the cell centre equals Open-Meteo's answer exactly — Open-Meteo
 * serves this same dataset, so this is a drop-in replacement for it.
 * Ocean has no tiles (verified: HTTP 404 for open sea); the dataset readme says to assume 0 m there.
 */
export interface DemTile {
  /** Row-major elevations, `width × height`. */
  readonly raster: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
  /** Top-left corner of the top-left pixel, degrees. */
  readonly west: number;
  readonly north: number;
  /** Pixel size in degrees (both positive). */
  readonly resLng: number;
  readonly resLat: number;
}

/** `Copernicus_DSM_COG_30_N37_00_E023_00_DEM` for a point at 37.96 N, 23.75 E. */
export function tileName(p: LngLat): string {
  const lat = Math.floor(p[1]);
  const lng = Math.floor(p[0]);
  const ns = `${lat >= 0 ? 'N' : 'S'}${String(Math.abs(lat)).padStart(2, '0')}_00`;
  const ew = `${lng >= 0 ? 'E' : 'W'}${String(Math.abs(lng)).padStart(3, '0')}_00`;
  return `Copernicus_DSM_COG_30_${ns}_${ew}_DEM`;
}

/**
 * Elevation of the pixel containing `p` (pixel edges at west + i·res, north − j·res).
 * Rounded to whole metres, matching what Open-Meteo returns for the same dataset.
 */
export function sampleTile(tile: DemTile, p: LngLat): number {
  const col = Math.floor((p[0] - tile.west) / tile.resLng);
  const row = Math.floor((tile.north - p[1]) / tile.resLat);
  if (row < 0 || col < 0 || row >= tile.height || col >= tile.width) {
    throw new ProviderError(PROVIDER, 'bad_response', `point ${p[0]},${p[1]} outside tile`);
  }
  const v = tile.raster[row * tile.width + col]!;
  if (!Number.isFinite(v)) throw new ProviderError(PROVIDER, 'bad_response', 'non-finite elevation in tile');
  return Math.round(v);
}

/** Decodes a GLO-90 GeoTIFF into a DemTile. */
export async function decodeTile(buffer: ArrayBuffer): Promise<DemTile> {
  const tiff = await fromArrayBuffer(buffer);
  const image = await tiff.getImage();
  const [west, north] = image.getOrigin() as [number, number];
  const [resLng, resLatSigned] = image.getResolution() as [number, number];
  const rasters = await image.readRasters({ interleave: true });
  return {
    raster: rasters as unknown as ArrayLike<number>,
    width: image.getWidth(),
    height: image.getHeight(),
    west,
    north,
    resLng,
    resLat: Math.abs(resLatSigned),
  };
}

export interface CopernicusAwsOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** Decoded tiles kept in memory (each ≈ 5.8 MB at 1200 × 1200 float32). */
  readonly memoryTiles?: number;
}

export function createCopernicusAwsDem(opts: CopernicusAwsOptions = {}): DemProvider {
  const baseUrl = opts.baseUrl ?? 'https://copernicus-dem-90m.s3.amazonaws.com';
  // `null` = ocean (no tile).
  const tiles = new MemoryLru<Promise<DemTile | null>>(opts.memoryTiles ?? 6);

  const load = async (name: string, signal?: AbortSignal): Promise<DemTile | null> => {
    const res = await fetchWithRetry(`${baseUrl}/${name}/${name}.tif`, {}, {
      provider: PROVIDER,
      timeoutMs: opts.timeoutMs ?? 30_000,
      retries: 2,
      baseDelayMs: 500,
      maxDelayMs: 4_000,
      ...(signal ? { signal } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    if (res.status === 404) return null; // no tile = ocean
    if (!res.ok) throw new ProviderError(PROVIDER, 'unavailable', `HTTP ${res.status}`, { status: res.status });
    try {
      return await decodeTile(await res.arrayBuffer());
    } catch (err) {
      throw new ProviderError(PROVIDER, 'bad_response', 'could not decode DEM tile', { cause: err });
    }
  };

  const tileFor = (name: string, signal?: AbortSignal): Promise<DemTile | null> => {
    let t = tiles.get(name);
    if (!t) {
      t = load(name, signal);
      tiles.set(name, t);
      // A failed download must not stay cached (the caller still sees the error).
      t.catch(() => tiles.delete(name));
    }
    return t;
  };

  return {
    name: PROVIDER,
    async elevations(points, signal) {
      const names = points.map(tileName);
      const unique = [...new Set(names)];
      const loaded = new Map(await Promise.all(unique.map(async (n) => [n, await tileFor(n, signal)] as const)));
      return points.map((p, i) => {
        const tile = loaded.get(names[i]!);
        return tile ? sampleTile(tile, p) : 0; // ocean
      });
    },
  };
}
