import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * GET a path; returns { data, error, loading, reload }.
 * path may be null (skipped). pollMs re-fetches silently while the browser tab is visible
 * (paused when hidden, refreshed on return). Only use it for database endpoints, never AI ones.
 */
export function useApi(path, { pollMs } = {}) {
  const [state, setState] = useState({ data: undefined, error: null, loading: Boolean(path) });

  const load = useCallback(
    (signal, silent = false) =>
      api(path, { signal })
        .then((data) =>
          setState((s) =>
            silent && JSON.stringify(s.data) === JSON.stringify(data) ? s : { data, error: null, loading: false },
          ),
        )
        .catch((error) => {
          if (error.name === 'AbortError') return;
          setState((s) => (silent ? s : { data: undefined, error, loading: false }));
        }),
    [path],
  );

  useEffect(() => {
    if (!path) {
      setState({ data: undefined, error: null, loading: false });
      return undefined;
    }
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [path, load]);

  useEffect(() => {
    if (!path || !pollMs) return undefined;
    const ctrl = new AbortController();
    const tick = () => document.visibilityState === 'visible' && load(ctrl.signal, true);
    const timer = setInterval(tick, pollMs);
    document.addEventListener('visibilitychange', tick);
    return () => {
      ctrl.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [path, pollMs, load]);

  return { ...state, reload: () => load(undefined, true) };
}
