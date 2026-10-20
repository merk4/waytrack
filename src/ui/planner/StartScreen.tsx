import { useState } from 'react';
import type { LngLat } from '../../domain/geo/types.ts';
import { PlaceSearch } from './PlaceSearch.tsx';

interface Props {
  onStart(position: LngLat): void;
}

const GEO_ERRORS: Record<number, string> = {
  1: 'Location permission was denied. Search for a place or tap the map instead.',
  2: "Your location isn't available right now. Search for a place or tap the map instead.",
  3: 'Finding your location took too long. Try again, or search instead.',
};

export function StartScreen({ onStart }: Props) {
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);

  const useMyLocation = () => {
    if (!('geolocation' in navigator)) {
      setGeoError("This browser can't share your location. Search for a place or tap the map instead.");
      return;
    }
    setLocating(true);
    setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        onStart([pos.coords.longitude, pos.coords.latitude]);
      },
      (err) => {
        setLocating(false);
        setGeoError(GEO_ERRORS[err.code] ?? GEO_ERRORS[2]!);
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  };

  return (
    <section aria-labelledby="start-title" className="space-y-4">
      <h1 id="start-title" className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-white">
        Where do you start?
      </h1>
      <button type="button" className="btn-primary w-full" onClick={useMyLocation} disabled={locating}>
        {locating ? 'Finding you…' : 'Use my location'}
      </button>
      {geoError && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {geoError}
        </p>
      )}
      <PlaceSearch near={undefined} placeholder="Street, place or address" onSelect={(p) => onStart(p)} />
      <p className="text-sm text-slate-600 dark:text-slate-400">…or tap the map to place your start.</p>
    </section>
  );
}
