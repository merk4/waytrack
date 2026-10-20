import { describe, expect, it } from 'vitest';
import { seededRandom } from '../../../test/helpers/geometry.ts';
import { ENGINE_CONFIG } from '../config/engineConfig.ts';
import { demCell, demCellCentre, demCellKey } from './demCell.ts';
import { gainLoss } from './gainLoss.ts';
import { buildProfile, ElevationDataError } from './profile.ts';
import { movingAverage } from './smooth.ts';

describe('movingAverage', () => {
  it('leaves constant and linear series unchanged (centred window)', () => {
    expect(movingAverage([5, 5, 5, 5, 5], 2)).toEqual([5, 5, 5, 5, 5]);
    const ramp = Array.from({ length: 20 }, (_, i) => 100 + 2 * i);
    movingAverage(ramp, 4).forEach((v, i) => expect(v).toBeCloseTo(ramp[i]!, 9));
  });

  it('preserves endpoints by shrinking the window symmetrically', () => {
    const out = movingAverage([0, 10, 0, 10, 0, 10], 2);
    expect(out[0]).toBe(0);
    expect(out[5]).toBe(10);
    expect(out[1]).toBeCloseTo((0 + 10 + 0) / 3, 9);
    expect(out[2]).toBeCloseTo((0 + 10 + 0 + 10 + 0) / 5, 9);
  });

  it('flattens a DEM staircase', () => {
    // Nearest-cell DEM sampled every 50 m over ~92 m cells: steps every ~2 samples.
    const stairs = [100, 100, 104, 104, 108, 108, 112, 112, 116, 116];
    const smooth = movingAverage(stairs, 2);
    for (let i = 3; i < smooth.length - 2; i++) expect(smooth[i]! - smooth[i - 1]!).toBeLessThan(4);
  });

  it('returns a copy for halfWindow 0, handles empty input, rejects bad windows', () => {
    const src = [1, 2, 3];
    const out = movingAverage(src, 0);
    expect(out).toEqual(src);
    expect(out).not.toBe(src);
    expect(movingAverage([], 3)).toEqual([]);
    expect(() => movingAverage(src, -1)).toThrow(RangeError);
    expect(() => movingAverage(src, 1.5)).toThrow(RangeError);
  });
});

describe('gainLoss (hysteresis)', () => {
  it('counts a monotonic climb in full', () => {
    expect(gainLoss([100, 101, 102, 103, 104, 105, 110], 4)).toEqual({ gain: 10, loss: 0 });
  });

  it('ignores oscillations smaller than the threshold', () => {
    expect(gainLoss([100, 103, 100, 103, 100, 102, 100], 4)).toEqual({ gain: 0, loss: 0 });
  });

  it('counts each confirmed reversal from the previous extreme', () => {
    // up 20, down 15, up 5 (≥4 → counts at end), then flat
    expect(gainLoss([100, 110, 120, 112, 105, 108, 110, 110], 4)).toEqual({ gain: 25, loss: 15 });
  });

  it('includes the final leg even if it never reverses', () => {
    expect(gainLoss([100, 90, 95, 99, 103, 107], 4)).toEqual({ gain: 17, loss: 10 });
  });

  it('with threshold 0 equals the sum of positive and negative steps', () => {
    const e = [100, 103, 101, 106, 106, 99, 100];
    expect(gainLoss(e, 0)).toEqual({ gain: 3 + 5 + 1, loss: 2 + 7 });
  });

  it('satisfies |net - (last - first)| < threshold on random profiles', () => {
    const rnd = seededRandom(42);
    for (let trial = 0; trial < 200; trial++) {
      const e: number[] = [100];
      for (let i = 0; i < 300; i++) e.push(e[i]! + (rnd() - 0.5) * 6);
      const t = 1 + rnd() * 6;
      const { gain, loss } = gainLoss(e, t);
      expect(Math.abs(gain - loss - (e.at(-1)! - e[0]!))).toBeLessThan(t);
      expect(gain).toBeGreaterThanOrEqual(0);
      expect(loss).toBeGreaterThanOrEqual(0);
      // Hysteresis can only remove gain, never invent it.
      expect(gain).toBeLessThanOrEqual(gainLoss(e, 0).gain + 1e-9);
    }
  });

  it('is zero for short input and rejects a negative threshold', () => {
    expect(gainLoss([], 4)).toEqual({ gain: 0, loss: 0 });
    expect(gainLoss([5], 4)).toEqual({ gain: 0, loss: 0 });
    expect(() => gainLoss([1, 2], -1)).toThrow(RangeError);
  });
});

describe('DEM cells', () => {
  const grid = ENGINE_CONFIG.dem;

  // Regression: live Open-Meteo probe 2026-10-19 at lng 23.7554, lat 37.9580 + i·0.0002
  // returned [152,152,149,149,149,149,151,151,151,151,142,...]. The value changed
  // exactly where floor(lat·1200) changes, so cells are [k/1200, (k+1)/1200).
  it('cell boundaries match the observed Open-Meteo grid', () => {
    const lat = (i: number) => 37.958 + i * 0.0002;
    const row = (i: number) => demCell([23.7554, lat(i)], grid).row;
    expect(row(0)).toBe(row(1));
    expect(row(2)).toBe(row(1) + 1);
    expect(row(5)).toBe(row(2));
    expect(row(6)).toBe(row(5) + 1);
    expect(row(10)).toBe(row(9) + 1);
    expect(row(15)).toBe(row(14) + 1);
  });

  it('key is stable within a cell and the centre maps back to the same cell', () => {
    const p = [23.75539, 37.96135] as const;
    const c = demCell(p, grid);
    expect(demCellKey(demCellCentre(c, grid), grid)).toBe(demCellKey(p, grid));
    expect(demCellKey([p[0] + 1e-6, p[1] + 1e-6], grid)).toBe(demCellKey(p, grid));
  });
});

describe('buildProfile', () => {
  const samples = { points: [[0.1, 0.1], [0.2, 0.2], [0.3, 0.3]] as [number, number][], distances: [0, 50, 100] };

  it('smooths with the configured window and keeps raw values', () => {
    const p = buildProfile(samples, [10, 20, 30], { ...ENGINE_CONFIG.elevation, smoothingHalfWindow: 1 });
    expect(p.raw).toEqual([10, 20, 30]);
    expect(p.smoothed).toEqual([10, 20, 30]);
  });

  it('rejects mismatched or non-finite elevation data', () => {
    expect(() => buildProfile(samples, [1, 2], ENGINE_CONFIG.elevation)).toThrow(ElevationDataError);
    expect(() => buildProfile(samples, [1, Number.NaN, 2], ENGINE_CONFIG.elevation)).toThrow(ElevationDataError);
  });
});
