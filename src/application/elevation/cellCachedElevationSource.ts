import type { DemGridConfig } from '../../domain/config/engineConfig.ts';
import { demCell, demCellCentre, demCellKey, type DemCell } from '../../domain/elevation/demCell.ts';
import type { ElevationSource } from '../../domain/elevation/source.ts';
import type { LngLat } from '../../domain/geo/types.ts';
import type { DemProvider, DemTileStore, Logger } from '../ports.ts';

export interface CellCachedElevationOptions {
  readonly dem: DemProvider;
  readonly tiles: DemTileStore;
  readonly grid: DemGridConfig;
  /** Cells per tile side. 32 ≈ 3.0 km × 2.3 km at Athens' latitude. */
  readonly tileSize: number;
  readonly logger: Logger;
}

export function tileKeyOf(cell: DemCell, tileSize: number): string {
  return `${Math.floor(cell.row / tileSize)}:${Math.floor(cell.col / tileSize)}`;
}

/**
 * ElevationSource that resolves each point to its DEM cell, serves cells from tiled
 * storage, and asks the DEM provider only for missing cells — always at the cell
 * centre, so stored values equal what the provider returns for any point in the cell
 * (see CLAUDE.md: Open-Meteo is nearest-cell with float32 edges).
 */
export function createCellCachedElevationSource(opts: CellCachedElevationOptions): ElevationSource {
  return {
    async lookup(points, signal) {
      const keys = points.map((p) => demCellKey(p, opts.grid));
      const cells = new Map<string, DemCell>();
      points.forEach((p, i) => cells.set(keys[i]!, demCell(p, opts.grid)));

      const byTile = new Map<string, string[]>();
      for (const [key, cell] of cells) {
        const t = tileKeyOf(cell, opts.tileSize);
        const list = byTile.get(t);
        if (list) list.push(key);
        else byTile.set(t, [key]);
      }

      const tiles = new Map<string, Record<string, number>>();
      await Promise.all(
        [...byTile.keys()].map(async (t) => tiles.set(t, { ...((await opts.tiles.get(t)) ?? {}) })),
      );

      const known = new Map<string, number>();
      const missing: string[] = [];
      for (const [t, list] of byTile) {
        const tile = tiles.get(t)!;
        for (const key of list) {
          const v = tile[key];
          if (v === undefined) missing.push(key);
          else known.set(key, v);
        }
      }

      if (missing.length > 0) {
        const centres: LngLat[] = missing.map((k) => demCellCentre(cells.get(k)!, opts.grid));
        const values = await opts.dem.elevations(centres, signal);
        if (values.length !== missing.length) {
          throw new Error(`DEM provider returned ${values.length} values for ${missing.length} cells`);
        }
        const dirty = new Set<string>();
        missing.forEach((key, i) => {
          known.set(key, values[i]!);
          const t = tileKeyOf(cells.get(key)!, opts.tileSize);
          tiles.get(t)![key] = values[i]!;
          dirty.add(t);
        });
        // A failed cache write must not fail the user's request, but it is never silent.
        await Promise.all(
          [...dirty].map((t) =>
            opts.tiles.put(t, tiles.get(t)!).catch((err: unknown) =>
              opts.logger.warn('dem_tile_write_failed', { tile: t, error: String(err) }),
            ),
          ),
        );
      }

      return keys.map((k) => known.get(k)!);
    },
  };
}
