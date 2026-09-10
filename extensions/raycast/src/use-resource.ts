import { useEffect, useRef, useState } from 'react';
import { api } from './api';
export function useResource<T>(path: string) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const current = useRef(path);
  current.current = path;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setData(undefined);
    api<T>(path, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted && current.current === path) setData(result);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Request failed');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, revision]);
  return { data, error, loading, refresh: () => setRevision((value) => value + 1) };
}
