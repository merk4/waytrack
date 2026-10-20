import { useCallback, useEffect, useRef, useState } from 'react';
import type { GenerateRequest } from '../../shared/api/contracts.ts';
import { api, ApiError, type GenerateProgress, type GenerateResult } from '../api/client.ts';

export type GenerateState =
  | { readonly status: 'idle' }
  | { readonly status: 'running'; readonly progress: GenerateProgress | undefined }
  | { readonly status: 'success'; readonly result: GenerateResult }
  | { readonly status: 'error'; readonly error: ApiError };

/** Runs one generation at a time with live progress; a new run or `cancel` aborts the previous one. */
export function useGenerate() {
  const [state, setState] = useState<GenerateState>({ status: 'idle' });
  const ctrl = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    ctrl.current?.abort();
    ctrl.current = null;
    setState({ status: 'idle' });
  }, []);

  const run = useCallback(async (req: GenerateRequest) => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setState({ status: 'running', progress: undefined });
    try {
      const result = await api.generate(req, (progress) => !c.signal.aborted && setState({ status: 'running', progress }), c.signal);
      if (!c.signal.aborted) setState({ status: 'success', result });
    } catch (err) {
      if (c.signal.aborted) return;
      setState({ status: 'error', error: err instanceof ApiError ? err : new ApiError('internal', 0, 'Something went wrong while generating routes.') });
    }
  }, []);

  useEffect(() => () => ctrl.current?.abort(), []);
  return { state, run, cancel, reset: cancel };
}
