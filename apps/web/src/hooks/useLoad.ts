import { useCallback, useEffect, useRef, useState } from 'react';
import { isCancelled } from '../api/client.js';
import type { ApiDiagnostics } from '../api/types.js';

export type Load<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string; httpStatus: number }
  | { status: 'ok'; data: T };

/**
 * Runs `run` when the component mounts (and again on reload), aborting it when the component goes away or a newer run starts.
 * Components that show customer data are keyed by the signed-in session, so a switch unmounts them: this abort is what
 * cancels their in-flight requests and the unmount is what discards their state.
 * `onFail` hears about every failure, including a quiet refresh whose error is not shown (a 401 there must still end the session).
 * `refresh` re-reads without going back to "loading", so rows and notices on screen stay put.
 */
export function useLoad<T>(run: (signal: AbortSignal) => Promise<{ data: T }>, enabled = true, onFail?: (httpStatus: number) => void) {
  const [state, setState] = useState<Load<T>>({ status: 'loading' });
  const [tick, setTick] = useState(0);
  const quiet = useRef(false);
  const runRef = useRef(run);
  runRef.current = run;
  const failRef = useRef(onFail);
  failRef.current = onFail;

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const silent = quiet.current;
    if (!silent) setState({ status: 'loading' });
    quiet.current = false;
    runRef.current(controller.signal).then(
      (res) => { if (!controller.signal.aborted) setState({ status: 'ok', data: res.data }); },
      (err: unknown) => {
        if (isCancelled(err) || controller.signal.aborted) return;
        const diag = (err as { diagnostics?: ApiDiagnostics }).diagnostics;
        failRef.current?.(diag?.httpStatus ?? 0); // also for a quiet refresh that keeps the old data on screen
        // A failed quiet refresh keeps what is already on screen rather than replacing it with an error.
        setState((prev) => (silent && prev.status === 'ok' ? prev : { status: 'error', message: (err as Error).message || 'Request failed', httpStatus: diag?.httpStatus ?? 0 }));
      },
    );
    return () => controller.abort();
  }, [tick, enabled]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const refresh = useCallback(() => { quiet.current = true; setTick((t) => t + 1); }, []);
  const update = useCallback((fn: (data: T) => T) => setState((s) => (s.status === 'ok' ? { status: 'ok', data: fn(s.data) } : s)), []);
  return { state, reload, refresh, update };
}
