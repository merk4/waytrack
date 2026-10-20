import type { DemTileStore, JsonCache, Logger } from '../../application/ports.ts';
import { MemoryLru } from './memoryLru.ts';

/** The subset of a Netlify Blobs store we use (keeps tests free of the SDK). */
export interface BlobStoreLike {
  get(key: string, opts: { type: 'json' }): Promise<unknown>;
  getWithMetadata(
    key: string,
    opts: { type: 'json' },
  ): Promise<{ data: unknown; metadata: Record<string, unknown> } | null>;
  setJSON(key: string, value: unknown, opts?: { metadata?: Record<string, unknown> }): Promise<unknown>;
  delete(key: string): Promise<void>;
}

const isCellRecord = (x: unknown): x is Record<string, number> =>
  typeof x === 'object' && x !== null && Object.values(x).every((v) => typeof v === 'number' && Number.isFinite(v));

/**
 * DEM tiles: memory LRU in front of Blobs. Values never expire. A corrupt tile is
 * logged and treated as empty (it will be refetched and overwritten).
 */
export function createDemTileStore(store: BlobStoreLike, logger: Logger, memoryTiles = 256): DemTileStore {
  const mem = new MemoryLru<Readonly<Record<string, number>>>(memoryTiles);
  return {
    async get(tileKey) {
      const hit = mem.get(tileKey);
      if (hit) return hit;
      const data = await store.get(tileKey, { type: 'json' });
      if (data === null || data === undefined) return undefined;
      if (!isCellRecord(data)) {
        logger.warn('dem_tile_corrupt', { tile: tileKey });
        return undefined;
      }
      mem.set(tileKey, data);
      return data;
    },
    async put(tileKey, cells) {
      mem.set(tileKey, cells);
      await store.setJSON(tileKey, cells);
    },
  };
}

/** TTL JSON cache: memory LRU in front of Blobs; expiry stored in blob metadata (Blobs has no TTL). */
export function createJsonCache(store: BlobStoreLike, now: () => number = Date.now, memoryEntries = 500): JsonCache {
  const mem = new MemoryLru<unknown>(memoryEntries, now);
  return {
    async get<T>(key: string) {
      const hit = mem.get(key);
      if (hit !== undefined) return hit as T;
      const res = await store.getWithMetadata(key, { type: 'json' });
      if (!res) return undefined;
      const expiresAt = Number(res.metadata['expiresAt']);
      if (!Number.isFinite(expiresAt) || expiresAt <= now()) {
        await store.delete(key);
        return undefined;
      }
      mem.set(key, res.data, expiresAt - now());
      return res.data as T;
    },
    async set(key, value, ttlS) {
      const expiresAt = now() + ttlS * 1000;
      mem.set(key, value, ttlS * 1000);
      await store.setJSON(key, value, { metadata: { expiresAt } });
    },
  };
}
