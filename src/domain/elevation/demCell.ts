import type { DemGridConfig } from '../config/engineConfig.ts';
import type { LngLat } from '../geo/types.ts';

/** Integer grid coordinates of a DEM cell. */
export interface DemCell {
  readonly row: number;
  readonly col: number;
}

/**
 * The DEM cell containing `p`. Because the elevation source answers with the value
 * of the containing cell, every point in a cell has the same elevation, which makes
 * this a lossless cache key.
 */
export function demCell(p: LngLat, grid: DemGridConfig): DemCell {
  return {
    row: Math.floor(p[1] * grid.cellsPerDegreeLat),
    col: Math.floor(p[0] * grid.cellsPerDegreeLng),
  };
}

export function demCellKey(p: LngLat, grid: DemGridConfig): string {
  const c = demCell(p, grid);
  return `${c.row}:${c.col}`;
}

/** Centre of a cell: a representative point to send to the elevation provider. */
export function demCellCentre(cell: DemCell, grid: DemGridConfig): LngLat {
  return [(cell.col + 0.5) / grid.cellsPerDegreeLng, (cell.row + 0.5) / grid.cellsPerDegreeLat];
}
