import { describe, expect, it } from 'vitest';
import { makeRoute, walk, ATHENS } from '../../../test/helpers/geometry.ts';
import { routeSchema } from './routeSchema.ts';

describe('routeSchema', () => {
  const valid = makeRoute(walk(ATHENS, [[90, 100]]), { roadClass: [{ from: 0, to: 4, value: 'footway' }] });

  it('accepts a canonical route', () => {
    expect(routeSchema.parse(valid)).toEqual(valid);
  });

  it.each([
    ['out-of-range coordinate', { ...valid, geometry: [[200, 0], [1, 1]] }],
    ['single point', { ...valid, geometry: [[1, 1]] }],
    ['unknown road class', { ...valid, attributes: { roadClass: [{ from: 0, to: 1, value: 'highway' }] } }],
    ['inverted span', { ...valid, attributes: { roadClass: [{ from: 3, to: 1, value: 'path' }] } }],
    ['bad timestamp', { ...valid, createdAt: 'yesterday' }],
  ])('rejects %s', (_, input) => {
    expect(routeSchema.safeParse(input).success).toBe(false);
  });
});
