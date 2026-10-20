import { useCallback, useEffect, useState } from 'react';

/**
 * Loads data for a screen: the result, the server's error message, and a reload for pull-to-refresh.
 * State only changes in the promise callbacks, and a screen that is gone ignores late answers.
 */
export function useResource<T>(fetcher: (signal: AbortSignal) => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetcher(controller.signal).then(
      (next) => { if (!controller.signal.aborted) { setData(next); setError(''); setRefreshing(false); } },
      (failure: Error) => { if (!controller.signal.aborted && failure.name !== 'AbortError') { setError(failure.message); setRefreshing(false); } }
    );
    return () => controller.abort();
  }, [fetcher, version]);

  const reload = useCallback(() => { setRefreshing(true); setVersion((value) => value + 1); }, []);
  /** Loads again without the pull-to-refresh spinner (a screen coming back into view). */
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  // After a change the server answers with the new state: show it without another request.
  return { data, error, reload, refresh, refreshing, replace: setData };
}
