import type { DemGridConfig } from '../../src/domain/config/engineConfig.ts';
import { demCellKey } from '../../src/domain/elevation/demCell.ts';
import type { ElevationSource } from '../../src/domain/elevation/source.ts';
import type { RecordedRouteFixture } from './fixtureSchema.ts';

/**
 * Replays recorded DEM cells. A lookup outside the recording throws: tests must
 * never silently invent elevation.
 */
export function fixtureElevationSource(fixture: RecordedRouteFixture): ElevationSource {
  const grid: DemGridConfig = fixture.elevation.grid;
  const cells = fixture.elevation.cells;
  return {
    lookup: async (points) =>
      points.map((p) => {
        const key = demCellKey(p, grid);
        const e = cells[key];
        if (e === undefined) throw new Error(`fixture has no elevation for DEM cell ${key} (${p[0]}, ${p[1]})`);
        return e;
      }),
  };
}
