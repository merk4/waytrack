import { concat } from '../../domain/route/compose.ts';
import type { Instruction, Waypoint } from '../../domain/route/types.ts';
import type { RoutedShape } from '../ports.ts';

/**
 * Joins consecutive routed legs (each starting where the previous ended) into one
 * shape: geometry, spans, waypoints and instructions are re-indexed; intermediate
 * "arrive" steps become "via".
 */
export function joinRoutedShapes(legs: readonly RoutedShape[]): RoutedShape {
  if (legs.length === 0) throw new RangeError('joinRoutedShapes: no legs');
  return legs.slice(1).reduce(joinPair, legs[0]!);
}

function joinPair(a: RoutedShape, b: RoutedShape): RoutedShape {
  // Snapped positions of the shared waypoint can differ by a few cm between requests;
  // force b to start exactly where a ends so concat's join check holds.
  const aEnd = a.geometry[a.geometry.length - 1]!;
  const shape = concat(a, { geometry: [aEnd, ...b.geometry.slice(1)], attributes: b.attributes });
  const offset = a.geometry.length - 1;
  const shift = (i: Instruction): Instruction => ({ ...i, from: i.from + offset, to: i.to + offset });
  // Drop a's "arrive" (it becomes a via) and b's duplicate first waypoint.
  const aInstr = a.instructions.map((i) => (i.turn === 'arrive' ? { ...i, turn: 'via' as const } : i));
  const waypoints: Waypoint[] = [
    ...a.waypoints,
    ...b.waypoints.slice(1).map((w) => ({ ...w, geometryIndex: w.geometryIndex + offset })),
  ];
  const ele = a.vertexElevations && b.vertexElevations ? [...a.vertexElevations, ...b.vertexElevations.slice(1)] : undefined;
  return { ...shape, waypoints, instructions: [...aInstr, ...b.instructions.map(shift)], ...(ele ? { vertexElevations: ele } : {}) };
}
