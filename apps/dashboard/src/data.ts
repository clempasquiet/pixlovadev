import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

/** Chargement d’une ressource `GET /api/v1…`, rechargeable après une action. */
export function useLoad<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const reload = useCallback(async () => {
    if (!path) return;
    try {
      setError(null);
      setData(await api<T>('GET', path));
    } catch (caught) {
      setError(caught);
    }
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, reload };
}
