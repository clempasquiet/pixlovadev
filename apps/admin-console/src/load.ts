import { useCallback, useEffect, useState } from 'react';

/** Chargement explicite : données, erreur, rechargement (aucune valeur par défaut inventée). */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const run = useCallback(load, deps);
  const reload = useCallback(async () => {
    setError(null);
    try {
      setData(await run());
    } catch (caught) {
      setError(caught);
    }
  }, [run]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, reload };
}
