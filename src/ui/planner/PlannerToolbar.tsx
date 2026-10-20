import type { Dispatch } from 'react';
import { canRedo, canUndo, isClosedLoop, type PlannerAction, type PlannerState } from '../../application/planner/plannerState.ts';
import { formatDistance } from '../format.ts';

interface Props {
  state: PlannerState;
  dispatch: Dispatch<PlannerAction>;
  distanceM: number;
  isEstimate: boolean;
  routing: boolean;
  onAddAtCentre(): void;
}

function ToolButton(props: { label: string; icon: string; disabled?: boolean; onClick(): void; shortcut?: string }) {
  return (
    <button
      type="button"
      className="btn-tool"
      onClick={props.onClick}
      disabled={props.disabled}
      aria-label={props.label}
      title={props.shortcut ? `${props.label} (${props.shortcut})` : props.label}
      {...(props.shortcut ? { 'aria-keyshortcuts': props.shortcut } : {})}
    >
      <span aria-hidden="true" className="text-lg leading-none">
        {props.icon}
      </span>
      <span className="text-[11px] leading-tight">{props.label}</span>
    </button>
  );
}

export function PlannerToolbar({ state, dispatch, distanceM, isEstimate, routing, onAddAtCentre }: Props) {
  const n = state.waypoints.length;
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <p className="text-3xl font-semibold tabular-nums text-slate-900 dark:text-white" aria-live="polite" data-testid="distance">
          <span className="sr-only">Distance </span>
          {isEstimate && n > 1 ? '≈ ' : ''}
          {formatDistance(distanceM)}
        </p>
        <p className="text-sm text-slate-600 dark:text-slate-400" aria-live="polite">
          {routing ? 'Snapping to paths…' : n < 2 ? 'Tap the map to add the next point' : `${n} points`}
        </p>
      </div>
      <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-7" role="toolbar" aria-label="Route tools">
        <ToolButton label="Undo" icon="↶" shortcut="Control+Z" disabled={!canUndo(state)} onClick={() => dispatch({ type: 'undo' })} />
        <ToolButton label="Redo" icon="↷" shortcut="Control+Shift+Z" disabled={!canRedo(state)} onClick={() => dispatch({ type: 'redo' })} />
        <ToolButton label="Close loop" icon="⟲" disabled={n < 2 || isClosedLoop(state.waypoints)} onClick={() => dispatch({ type: 'closeLoop' })} />
        <ToolButton label="Out & back" icon="⇄" disabled={n < 2} onClick={() => dispatch({ type: 'outAndBack' })} />
        <ToolButton label="Reverse" icon="⇅" disabled={n < 2} onClick={() => dispatch({ type: 'reverse' })} />
        <ToolButton label="Add at centre" icon="⊕" onClick={onAddAtCentre} />
        <ToolButton label="Clear" icon="✕" disabled={n === 0} onClick={() => dispatch({ type: 'clear' })} />
      </div>
    </div>
  );
}
