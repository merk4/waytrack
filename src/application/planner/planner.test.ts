import { describe, expect, it } from 'vitest';
import { ATHENS, offset } from '../../../test/helpers/geometry.ts';
import type { LngLat } from '../../domain/geo/types.ts';
import type { RoutedShape } from '../ports.ts';
import { assembleRoute, legsOf, type LegState } from './assembleRoute.ts';
import { canRedo, canUndo, initialPlannerState, isClosedLoop, plannerReducer, type PlannerAction, type PlannerState } from './plannerState.ts';

const P = (i: number): LngLat => offset(ATHENS, i * 300, 0);
const run = (actions: PlannerAction[], from: PlannerState = initialPlannerState) => actions.reduce(plannerReducer, from);
const three = run([{ type: 'add', point: P(0) }, { type: 'add', point: P(1) }, { type: 'add', point: P(2) }]);

describe('plannerReducer', () => {
  it('adds waypoints and ignores accidental double taps', () => {
    expect(three.waypoints).toEqual([P(0), P(1), P(2)]);
    const s = plannerReducer(three, { type: 'add', point: offset(P(2), 2, 0) });
    expect(s).toBe(three);
  });

  it('undo/redo walk the history; a new edit clears redo', () => {
    const u = run([{ type: 'undo' }, { type: 'undo' }], three);
    expect(u.waypoints).toEqual([P(0)]);
    expect(canRedo(u)).toBe(true);
    expect(run([{ type: 'redo' }], u).waypoints).toEqual([P(0), P(1)]);
    const branched = plannerReducer(u, { type: 'add', point: P(5) });
    expect(canRedo(branched)).toBe(false);
    expect(run([{ type: 'undo' }, { type: 'undo' }, { type: 'undo' }, { type: 'undo' }], three).waypoints).toEqual([]);
    expect(canUndo(initialPlannerState)).toBe(false);
    expect(plannerReducer(initialPlannerState, { type: 'undo' })).toBe(initialPlannerState);
  });

  it('close loop appends the start once', () => {
    const loop = plannerReducer(three, { type: 'closeLoop' });
    expect(loop.waypoints).toEqual([P(0), P(1), P(2), P(0)]);
    expect(isClosedLoop(loop.waypoints)).toBe(true);
    expect(plannerReducer(loop, { type: 'closeLoop' })).toBe(loop);
  });

  it('out-and-back retraces the waypoints to the start', () => {
    expect(plannerReducer(three, { type: 'outAndBack' }).waypoints).toEqual([P(0), P(1), P(2), P(1), P(0)]);
  });

  it('reverse flips direction', () => {
    expect(plannerReducer(three, { type: 'reverse' }).waypoints).toEqual([P(2), P(1), P(0)]);
  });

  it('move and remove; dragging a loop start keeps the loop closed', () => {
    expect(plannerReducer(three, { type: 'move', index: 1, point: P(9) }).waypoints).toEqual([P(0), P(9), P(2)]);
    expect(plannerReducer(three, { type: 'remove', index: 0 }).waypoints).toEqual([P(1), P(2)]);
    const loop = plannerReducer(three, { type: 'closeLoop' });
    const moved = plannerReducer(loop, { type: 'move', index: 0, point: P(7) });
    expect(moved.waypoints[0]).toEqual(P(7));
    expect(moved.waypoints.at(-1)).toEqual(P(7));
  });

  it('inapplicable edits are no-ops that do not touch history', () => {
    const one = run([{ type: 'add', point: P(0) }]);
    for (const a of [{ type: 'closeLoop' }, { type: 'outAndBack' }, { type: 'reverse' }, { type: 'remove', index: 5 }, { type: 'move', index: -1, point: P(1) }] as PlannerAction[]) {
      expect(plannerReducer(one, a)).toBe(one);
    }
    expect(plannerReducer(initialPlannerState, { type: 'clear' })).toBe(initialPlannerState);
  });
});

describe('assembleRoute', () => {
  const wps = [P(0), P(1), P(2)];
  const leg = (a: LngLat, b: LngLat): RoutedShape => ({
    geometry: [a, offset(a, 150, 50), b],
    attributes: {},
    waypoints: [{ position: a, geometryIndex: 0 }, { position: b, geometryIndex: 2 }],
    instructions: [{ turn: 'arrive', text: 'Arrive', streetName: '', distanceM: 0, from: 2, to: 2 }],
  });

  it('pairs consecutive waypoints into legs', () => {
    expect(legsOf(wps)).toEqual([[P(0), P(1)], [P(1), P(2)]]);
    expect(legsOf([P(0)])).toEqual([]);
  });

  it('estimates distance with straight lines while legs are pending, flags failures', () => {
    const r = assembleRoute(wps, [{ status: 'ready', shape: leg(P(0), P(1)) }, { status: 'error', error: new Error('x') }]);
    expect(r.route).toBeUndefined();
    expect(r.isEstimate).toBe(true);
    expect(r.failedLegs).toEqual([1]);
    expect(r.distanceM).toBeGreaterThan(600);
    expect(assembleRoute(wps, [{ status: 'pending' }, { status: 'pending' }]).distanceM).toBeCloseTo(600, 0);
  });

  it('joins all legs once ready', () => {
    const legs: LegState[] = [{ status: 'ready', shape: leg(P(0), P(1)) }, { status: 'ready', shape: leg(P(1), P(2)) }];
    const r = assembleRoute(wps, legs);
    expect(r.isEstimate).toBe(false);
    expect(r.route!.geometry).toHaveLength(5);
    expect(r.route!.waypoints.map((w) => w.geometryIndex)).toEqual([0, 2, 4]);
    expect(r.route!.instructions.map((i) => i.turn)).toEqual(['via', 'arrive']);
  });

  it('rejects a leg count mismatch', () => {
    expect(() => assembleRoute(wps, [])).toThrow(RangeError);
  });
});
