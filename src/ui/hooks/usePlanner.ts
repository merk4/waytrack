import { useEffect, useReducer } from 'react';
import { initialPlannerState, plannerReducer } from '../../application/planner/plannerState.ts';

/** Planner state plus global undo/redo shortcuts (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y). */
export function usePlanner() {
  const [state, dispatch] = useReducer(plannerReducer, initialPlannerState);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) dispatch({ type: 'undo' });
      else if ((k === 'z' && e.shiftKey) || k === 'y') dispatch({ type: 'redo' });
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return { state, dispatch };
}
