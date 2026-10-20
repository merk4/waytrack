import { getStore } from '@netlify/blobs';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { createCellCachedElevationSource } from '../application/elevation/cellCachedElevationSource.ts';
import { cachedGeocoder } from '../application/geocoding/cachedGeocoder.ts';
import type { Logger } from '../application/ports.ts';
import { ENGINE_CONFIG } from '../domain/config/engineConfig.ts';
import { createDemTileStore, createJsonCache, type BlobStoreLike } from '../infrastructure/cache/blobStores.ts';
import { createConsoleLogger } from '../infrastructure/logging/logger.ts';
import { TokenBucket } from '../infrastructure/rateLimit/tokenBucket.ts';
import { WindowLimiter } from '../infrastructure/rateLimit/windowLimiter.ts';
import { createCopernicusAwsDem } from '../providers/elevation/copernicusAws/copernicusAwsDem.ts';
import { createOpenMeteoDem } from '../providers/elevation/openmeteo/openMeteoDem.ts';
import { createNominatimGeocoder } from '../providers/geocoding/nominatim/nominatimGeocoder.ts';
import { createPhotonGeocoder } from '../providers/geocoding/photon/photonGeocoder.ts';
import { createGraphHopperRouting } from '../providers/routing/graphhopper/graphhopperRouting.ts';
import type { ServerDeps } from './handlers.ts';

const envSchema = z.object({
  GRAPH_HOPPER_API_KEY: z.string().min(1).optional(),
  /** Optional contact appended to the User-Agent (Nominatim policy recommends one). */
  WAYMARK_CONTACT: z.string().min(1).optional(),
  /** Outside Netlify: directory for the persistent local cache (default `.cache/blobs`; "off" = memory). */
  WAYMARK_LOCAL_CACHE_DIR: z.string().min(1).optional(),
  NETLIFY: z.string().optional(),
  /**
   * Where DEM cells come from. Both serve Copernicus GLO-90 with identical values (verified):
   * `copernicus-aws` (default) reads the public AWS Open Data tiles — no key, no quota;
   * `open-meteo` uses its API (free tier: 600/min, 5,000/h, 10,000/day locations).
   */
  ELEVATION_PROVIDER: z.enum(['copernicus-aws', 'open-meteo']).default('copernicus-aws'),
});

/** In-memory stand-in for Netlify Blobs when running outside a Netlify environment. */
function memoryBlobStore(): BlobStoreLike {
  const data = new Map<string, { value: unknown; metadata: Record<string, unknown> }>();
  return {
    get: async (k) => data.get(k)?.value ?? null,
    getWithMetadata: async (k) => {
      const e = data.get(k);
      return e ? { data: e.value, metadata: e.metadata } : null;
    },
    setJSON: async (k, value, opts) => void data.set(k, { value, metadata: opts?.metadata ?? {} }),
    delete: async (k) => void data.delete(k),
  };
}

/**
 * Local stand-in for Netlify Blobs that survives restarts (`npm run dev`): one JSON file
 * per key under `dir/store/`. Elevation never changes, so caching it on disk saves the
 * free elevation quota that every restart would otherwise spend again.
 */
export function fileBlobStore(dir: string): BlobStoreLike {
  mkdirSync(dir, { recursive: true });
  const file = (k: string) => join(dir, `${encodeURIComponent(k)}.json`);
  const read = (k: string): { value: unknown; metadata: Record<string, unknown> } | null => {
    try {
      return JSON.parse(readFileSync(file(k), 'utf8')) as { value: unknown; metadata: Record<string, unknown> };
    } catch {
      return null; // missing or unreadable: a cache miss
    }
  };
  return {
    get: async (k) => read(k)?.value ?? null,
    getWithMetadata: async (k) => {
      const e = read(k);
      return e ? { data: e.value, metadata: e.metadata } : null;
    },
    setJSON: async (k, value, opts) => writeFileSync(file(k), JSON.stringify({ value, metadata: opts?.metadata ?? {} })),
    delete: async (k) => rmSync(file(k), { force: true }),
  };
}

function blobStore(name: string, logger: Logger, localDir: string | undefined): BlobStoreLike {
  try {
    const store: BlobStoreLike = getStore({ name, consistency: 'eventual' });
    return store;
  } catch (err) {
    // Explicit, logged degradation outside Netlify: a local file cache if configured, else memory.
    if (localDir) {
      logger.info('blobs_unavailable_using_local_files', { store: name, dir: localDir });
      return fileBlobStore(join(localDir, name));
    }
    logger.warn('blobs_unavailable_using_memory', { store: name, error: String(err) });
    return memoryBlobStore();
  }
}

let deps: ServerDeps | undefined;

/** Composition root. Built once per function instance; limiters and memory caches are shared within it. */
export function getServerDeps(env: NodeJS.ProcessEnv = process.env): ServerDeps {
  if (deps) return deps;
  const logger = createConsoleLogger({ app: 'waymark' });
  const cfg = envSchema.parse(env);
  const userAgent = `Waymark/0.1 (personal running-route planner${cfg.WAYMARK_CONTACT ? `; ${cfg.WAYMARK_CONTACT}` : ''})`;

  // Outgoing pacing. GraphHopper's free per-minute limit is undocumented; measured 2026-10-19:
  // blocked after 11 requests in 37 s ("Minutely API limit heavily violated") → ~10 credits/min.
  const ghCredits = new TokenBucket({ capacity: 8, refill: 10, perMs: 60_000 });
  const omLocations = new TokenBucket({ capacity: 550, refill: 550, perMs: 60_000 });
  const nominatimRate = new TokenBucket({ capacity: 1, refill: 1, perMs: 1_100 });
  const photonRate = new TokenBucket({ capacity: 1, refill: 1, perMs: 1_000 });

  const localDir = cfg.NETLIFY ? undefined : cfg.WAYMARK_LOCAL_CACHE_DIR === 'off' ? undefined : (cfg.WAYMARK_LOCAL_CACHE_DIR ?? join(process.cwd(), '.cache', 'blobs'));
  const geocodeCache = createJsonCache(blobStore('geocode', logger, localDir));
  deps = {
    routing: cfg.GRAPH_HOPPER_API_KEY
      ? createGraphHopperRouting({ apiKey: cfg.GRAPH_HOPPER_API_KEY, credits: ghCredits })
      : undefined,
    elevation: createCellCachedElevationSource({
      dem: cfg.ELEVATION_PROVIDER === 'open-meteo' ? createOpenMeteoDem({ locations: omLocations }) : createCopernicusAwsDem(),
      tiles: createDemTileStore(blobStore('dem-tiles', logger, localDir), logger),
      grid: ENGINE_CONFIG.dem,
      tileSize: 32,
      logger,
    }),
    elevationSourceName: cfg.ELEVATION_PROVIDER === 'open-meteo' ? 'Copernicus DEM GLO-90 via Open-Meteo' : 'Copernicus DEM GLO-90 (AWS Open Data)',
    geocoders: {
      primary: cachedGeocoder(createNominatimGeocoder({ userAgent, limiter: nominatimRate }), geocodeCache, logger),
      secondary: cachedGeocoder(createPhotonGeocoder({ userAgent, limiter: photonRate }), geocodeCache, logger),
    },
    routeCache: createJsonCache(blobStore('routes', logger, localDir)),
    limiters: {
      route: new WindowLimiter(60, 60_000),
      elevation: new WindowLimiter(60, 60_000),
      geocode: new WindowLimiter(20, 60_000),
      generate: new WindowLimiter(6, 60_000),
    },
    logger,
  };
  return deps;
}
