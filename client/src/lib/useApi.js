import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

/** GET a path; returns { data, error, loading, reload }. */
export function useApi(path) {
  const [state, setState] = useState({ data: undefined, error: null, loading: true });

  const load = useCallback(
    (signal) =>
      api(path, { signal })
        .then((data) => setState({ data, error: null, loading: false }))
        .catch((error) => {
          if (error.name !== 'AbortError') setState({ data: undefined, error, loading: false });
        }),
    [path],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  return { ...state, reload: () => load() };
}
