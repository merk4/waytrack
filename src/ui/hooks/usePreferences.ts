import { useEffect, useState, useSyncExternalStore } from 'react';

const query = '(prefers-color-scheme: dark)';

export function useColorScheme(): 'light' | 'dark' {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(query);
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () => (window.matchMedia(query).matches ? 'dark' : 'light'),
  );
}

/** Per-viewer convenience stored in localStorage; works (unpersisted) if storage is unavailable. */
export function useStoredState<T>(key: string, initial: T, valid: (v: unknown) => v is T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      const parsed: unknown = raw === null ? undefined : JSON.parse(raw);
      return valid(parsed) ? parsed : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage blocked (private mode): the preference simply isn't remembered.
    }
  }, [key, value]);
  return [value, setValue];
}
