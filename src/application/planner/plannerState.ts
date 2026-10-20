import { distance } from '../../domain/geo/distance.ts';
import type { LngLat } from '../../domain/geo/types.ts';

/** Waypoints closer than this to the previous one are ignored (accidental double taps). */
export const MIN_WAYPOINT_SPACING_M = 5;
const HISTORY_LIMIT = 100;

export interface PlannerState {
  readonly waypoints: readonly LngLat[];
  readonly past: readonly (readonly LngLat[])[];
  readonly future: readonly (readonly LngLat[])[];
}

export type PlannerAction =
  | { readonly type: 'add'; readonly point: LngLat }
  | { readonly type: 'move'; readonly index: number; readonly point: LngLat }
  | { readonly type: 'remove'; readonly index: number }
  | { readonly type: 'clear' }
  | { readonly type: 'closeLoop' }
  | { readonly type: 'outAndBack' }
  | { readonly type: 'reverse' }
  | { readonly type: 'undo' }
  | { readonly type: 'redo' };

export const initialPlannerState: PlannerState = { waypoints: [], past: [], future: [] };

const same = (a: LngLat, b: LngLat) => distance(a, b) < MIN_WAYPOINT_SPACING_M;

export function isClosedLoop(w: readonly LngLat[]): boolean {
  return w.length >= 3 && same(w[0]!, w[w.length - 1]!);
}

/** The waypoint list an edit produces, or `undefined` if the edit does not apply. */
function edit(w: readonly LngLat[], action: PlannerAction): readonly LngLat[] | undefined {
  switch (action.type) {
    case 'add':
      return w.length > 0 && same(w[w.length - 1]!, action.point) ? undefined : [...w, action.point];
    case 'move': {
      if (action.index < 0 || action.index >= w.length) return undefined;
      const next = w.map((p, i) => (i === action.index ? action.point : p));
      // Keep a closed loop closed when its start/finish is dragged.
      if (isClosedLoop(w) && (action.index === 0 || action.index === w.length - 1)) {
        next[0] = action.point;
        next[next.length - 1] = action.point;
      }
      return next;
    }
    case 'remove':
      return action.index < 0 || action.index >= w.length ? undefined : w.filter((_, i) => i !== action.index);
    case 'clear':
      return w.length === 0 ? undefined : [];
    case 'closeLoop':
      return w.length < 2 || isClosedLoop(w) ? undefined : [...w, w[0]!];
    case 'outAndBack':
      return w.length < 2 ? undefined : [...w, ...w.slice(0, -1).reverse()];
    case 'reverse':
      return w.length < 2 ? undefined : [...w].reverse();
    case 'undo':
    case 'redo':
      return undefined;
  }
}

export function plannerReducer(state: PlannerState, action: PlannerAction): PlannerState {
  if (action.type === 'undo') {
    const prev = state.past[state.past.length - 1];
    return prev === undefined ? state : { waypoints: prev, past: state.past.slice(0, -1), future: [state.waypoints, ...state.future] };
  }
  if (action.type === 'redo') {
    const next = state.future[0];
    return next === undefined ? state : { waypoints: next, past: [...state.past, state.waypoints], future: state.future.slice(1) };
  }
  const waypoints = edit(state.waypoints, action);
  if (waypoints === undefined) return state;
  return { waypoints, past: [...state.past, state.waypoints].slice(-HISTORY_LIMIT), future: [] };
}

export const canUndo = (s: PlannerState) => s.past.length > 0;
export const canRedo = (s: PlannerState) => s.future.length > 0;
