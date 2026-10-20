import type { Dispatch } from 'react';
import type { PlannerAction } from '../../application/planner/plannerState.ts';
import type { LngLat } from '../../domain/geo/types.ts';

interface Props {
  waypoints: readonly LngLat[];
  failedLegs: readonly number[];
  dispatch: Dispatch<PlannerAction>;
}

/** Keyboard/screen-reader route to the waypoints that are otherwise only on the map. */
export function WaypointList({ waypoints, failedLegs, dispatch }: Props) {
  if (waypoints.length === 0) return null;
  return (
    <details className="rounded-xl border border-slate-200 dark:border-slate-700">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-slate-800 dark:text-slate-200">Waypoints ({waypoints.length})</summary>
      <ol className="divide-y divide-slate-200 dark:divide-slate-700">
        {waypoints.map((p, i) => (
          <li key={i} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
            <span className="text-slate-700 dark:text-slate-300">
              {i === 0 ? 'Start' : i === waypoints.length - 1 ? 'Finish' : `Point ${i + 1}`}
              <span className="ml-2 font-mono text-xs text-slate-500 dark:text-slate-400">
                {p[1].toFixed(5)}, {p[0].toFixed(5)}
              </span>
              {failedLegs.includes(i - 1) && <span className="ml-2 text-red-700 dark:text-red-300">· can't route here</span>}
            </span>
            <button type="button" className="btn-link" onClick={() => dispatch({ type: 'remove', index: i })} aria-label={`Remove ${i === 0 ? 'start' : `point ${i + 1}`}`}>
              Remove
            </button>
          </li>
        ))}
      </ol>
    </details>
  );
}
