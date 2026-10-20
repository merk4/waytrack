import { useMutation } from '@tanstack/react-query';
import { useId, useState } from 'react';
import type { LngLat } from '../../domain/geo/types.ts';
import type { GeocodeResponse } from '../../shared/api/contracts.ts';
import { api } from '../api/client.ts';

interface Props {
  near: LngLat | undefined;
  placeholder: string;
  onSelect(position: LngLat, label: string): void;
}

/**
 * Search on submit only — Nominatim's usage policy forbids autocomplete.
 */
export function PlaceSearch({ near, placeholder, onSelect }: Props) {
  const id = useId();
  const [q, setQ] = useState('');
  const search = useMutation<GeocodeResponse, Error, string>({ mutationFn: (text) => api.geocode(text, near) });
  const results = search.data?.results;

  return (
    <div className="w-full">
      <form
        role="search"
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim().length >= 2) search.mutate(q.trim());
        }}
      >
        <label htmlFor={id} className="sr-only">
          Search for a place
        </label>
        <input
          id={id}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          className="min-h-11 flex-1 rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 placeholder:text-slate-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:placeholder:text-slate-400"
        />
        <button type="submit" className="btn-primary" disabled={search.isPending || q.trim().length < 2}>
          {search.isPending ? 'Searching…' : 'Search'}
        </button>
      </form>

      <div aria-live="polite" className="mt-2">
        {search.isError && (
          <p className="text-sm text-red-700 dark:text-red-300">
            {search.error.message}{' '}
            <button type="button" className="underline" onClick={() => search.mutate(q.trim())}>
              Retry
            </button>
          </p>
        )}
        {results && results.length === 0 && <p className="text-sm text-slate-600 dark:text-slate-300">No places found. Try adding the area or city.</p>}
        {results && results.length > 0 && (
          <ul className="max-h-60 overflow-auto rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800" aria-label="Search results">
            {results.map((r, i) => (
              <li key={`${r.label}-${i}`}>
                <button
                  type="button"
                  className="w-full px-3 py-2.5 text-left hover:bg-slate-100 focus-visible:bg-slate-100 dark:hover:bg-slate-700 dark:focus-visible:bg-slate-700"
                  onClick={() => {
                    onSelect(r.position, r.name);
                    search.reset();
                    setQ('');
                  }}
                >
                  <span className="block font-medium text-slate-900 dark:text-slate-100">{r.name}</span>
                  <span className="block truncate text-sm text-slate-600 dark:text-slate-400">{r.label}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {search.data?.fallback && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Results from {search.data.provider}.</p>}
      </div>
    </div>
  );
}
