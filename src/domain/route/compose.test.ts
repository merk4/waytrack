import { describe, expect, it } from 'vitest';
import { ATHENS, offset, walk } from '../../../test/helpers/geometry.ts';
import { distance, lineLength } from '../geo/distance.ts';
import { concat, outAndBack, reverse, RouteCompositionError, truncate, type RouteShape } from './compose.ts';
import { distanceByValue } from './spans.ts';
import { measure } from '../geo/distance.ts';

// 1 km east in 4 × 250 m segments: primary, primary, footway, residential.
const shape: RouteShape = {
  geometry: walk(ATHENS, [[90, 1000]], 250),
  attributes: {
    roadClass: [
      { from: 0, to: 2, value: 'primary' },
      { from: 2, to: 3, value: 'footway' },
      { from: 3, to: 4, value: 'residential' },
    ],
    access: [{ from: 0, to: 4, value: 'yes' }],
  },
};
const metresOf = (s: RouteShape, v: string) =>
  distanceByValue(measure(s.geometry), s.attributes.roadClass, 'unknown').get(v as never) ?? 0;

describe('reverse', () => {
  it('reverses geometry and remaps spans so each segment keeps its class', () => {
    const r = reverse(shape);
    expect(r.geometry[0]).toEqual(shape.geometry[4]);
    expect(r.attributes.roadClass).toEqual([
      { from: 0, to: 1, value: 'residential' },
      { from: 1, to: 2, value: 'footway' },
      { from: 2, to: 4, value: 'primary' },
    ]);
    expect(metresOf(r, 'primary')).toBeCloseTo(metresOf(shape, 'primary'), 6);
    expect(reverse(r)).toEqual(shape);
  });
});

describe('concat / outAndBack', () => {
  it('joins at the shared point without duplicating it and offsets spans', () => {
    const ob = outAndBack(shape);
    expect(ob.geometry).toHaveLength(9);
    expect(lineLength(ob.geometry)).toBeCloseTo(2 * lineLength(shape.geometry), 6);
    expect(ob.geometry.at(-1)).toEqual(shape.geometry[0]);
    expect(metresOf(ob, 'primary')).toBeCloseTo(1000, 3);
    expect(metresOf(ob, 'footway')).toBeCloseTo(500, 3);
    expect(ob.attributes.access).toEqual([
      { from: 0, to: 4, value: 'yes' },
      { from: 4, to: 8, value: 'yes' },
    ]);
  });

  it('refuses to join shapes that do not touch', () => {
    const elsewhere: RouteShape = { geometry: walk(offset(ATHENS, 0, 50), [[90, 100]]), attributes: {} };
    expect(() => concat(shape, elsewhere)).toThrow(RouteCompositionError);
  });

  it('treats empty shapes as identity and omits attributes neither side has', () => {
    const empty: RouteShape = { geometry: [], attributes: {} };
    expect(concat(empty, shape)).toBe(shape);
    expect(concat(shape, empty)).toBe(shape);
    const bare: RouteShape = { geometry: shape.geometry, attributes: {} };
    expect(outAndBack(bare).attributes).toEqual({});
  });
});

describe('truncate', () => {
  it('cuts at an interpolated point and clips spans', () => {
    const t = truncate(shape, 600);
    expect(lineLength(t.geometry)).toBeCloseTo(600, 6);
    expect(distance(t.geometry.at(-1)!, offset(ATHENS, 600, 0))).toBeLessThan(0.01);
    expect(t.attributes.roadClass).toEqual([
      { from: 0, to: 2, value: 'primary' },
      { from: 2, to: 3, value: 'footway' },
    ]);
    expect(metresOf(t, 'footway')).toBeCloseTo(100, 3);
  });

  it.each([500, 500 - 1e-4, 500 + 1e-4])('cutting at %d m (on a vertex) does not create a zero-length segment', (m) => {
    const t = truncate(shape, m);
    expect(t.geometry).toHaveLength(3);
    expect(lineLength(t.geometry)).toBeCloseTo(500, 3);
  });

  it('returns the shape unchanged when longer than it, and rejects non-positive lengths', () => {
    expect(truncate(shape, 5000)).toBe(shape);
    expect(() => truncate(shape, 0)).toThrow(RangeError);
  });
});
