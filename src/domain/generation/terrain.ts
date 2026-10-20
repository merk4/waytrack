import { metresPerDegree } from '../geo/distance.ts';
import type { LngLat } from '../geo/types.ts';

/** A square elevation grid centred on the start, row 0 = southernmost. */
export interface TerrainGrid {
  readonly centre: LngLat;
  readonly size: number;
  readonly spacingM: number;
  /** Row-major, `size × size`. */
  readonly elevations: readonly number[];
}

/** Grid sample positions (row-major, south→north, west→east) to send to the elevation source. */
export function scanPoints(centre: LngLat, size: number, spacingM: number): LngLat[] {
  if (!Number.isInteger(size) || size < 2) throw new RangeError('scan size must be an integer ≥ 2');
  const k = metresPerDegree(centre[1]);
  const half = (size - 1) / 2;
  const out: LngLat[] = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      out.push([centre[0] + ((c - half) * spacingM) / k.lng, centre[1] + ((r - half) * spacingM) / k.lat]);
    }
  }
  return out;
}

export function makeGrid(centre: LngLat, size: number, spacingM: number, elevations: readonly number[]): TerrainGrid {
  if (elevations.length !== size * size) throw new RangeError(`expected ${size * size} elevations, got ${elevations.length}`);
  return { centre, size, spacingM, elevations };
}

/** Bilinear elevation at `p`, clamped to the grid edge. */
export function elevationAt(grid: TerrainGrid, p: LngLat): number {
  const k = metresPerDegree(grid.centre[1]);
  const half = (grid.size - 1) / 2;
  const fc = Math.max(0, Math.min(grid.size - 1, ((p[0] - grid.centre[0]) * k.lng) / grid.spacingM + half));
  const fr = Math.max(0, Math.min(grid.size - 1, ((p[1] - grid.centre[1]) * k.lat) / grid.spacingM + half));
  const c0 = Math.min(grid.size - 2, Math.floor(fc));
  const r0 = Math.min(grid.size - 2, Math.floor(fr));
  const tc = fc - c0;
  const tr = fr - r0;
  const e = (r: number, c: number) => grid.elevations[r * grid.size + c]!;
  return (
    e(r0, c0) * (1 - tc) * (1 - tr) + e(r0, c0 + 1) * tc * (1 - tr) + e(r0 + 1, c0) * (1 - tc) * tr + e(r0 + 1, c0 + 1) * tc * tr
  );
}

/** Grid cells (excluding the centre) as candidate targets. */
export function gridCells(grid: TerrainGrid): { position: LngLat; elevation: number; row: number; col: number }[] {
  const pts = scanPoints(grid.centre, grid.size, grid.spacingM);
  const mid = (grid.size - 1) / 2;
  return pts
    .map((position, i) => ({ position, elevation: grid.elevations[i]!, row: Math.floor(i / grid.size), col: i % grid.size }))
    .filter((c) => !(c.row === mid && c.col === mid));
}
