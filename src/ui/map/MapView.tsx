import type { Map as MlMap, Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { LngLat } from '../../domain/geo/types.ts';
import { MAP_STYLES } from '../config.ts';
import type { LineFeature } from './routeFeatures.ts';

export interface MapHandle {
  getCenter(): LngLat | undefined;
  /** Instant (no animation): a fly from a continent-wide view is slow, races "add at centre", and is hard on motion-sensitive users. */
  centreOn(p: LngLat, zoom?: number): void;
  fitTo(points: readonly LngLat[]): void;
}

export interface MapViewProps {
  ref?: Ref<MapHandle>;
  scheme: 'light' | 'dark';
  initialCenter: LngLat;
  initialZoom: number;
  waypoints: readonly LngLat[];
  /** Plain route (while elevation is loading) — drawn in a neutral colour. */
  routeGeometry: readonly LngLat[] | undefined;
  /** Other route options, drawn faintly underneath. */
  altGeometries?: readonly (readonly LngLat[])[];
  /** Gradient-coloured route, when analysis is ready. */
  gradeFeatures: readonly LineFeature[] | undefined;
  kmMarkers: readonly { km: number; position: LngLat }[];
  turnarounds: readonly LngLat[];
  highlight: LngLat | undefined;
  onAddWaypoint(p: LngLat): void;
  onMoveWaypoint(index: number, p: LngLat): void;
}

type MapLibre = typeof import('maplibre-gl');

const EMPTY = { type: 'FeatureCollection' as const, features: [] };
const STYLE_TIMEOUT_MS = 15_000;

function el(className: string, text?: string, label?: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  if (text !== undefined) d.textContent = text;
  if (label) {
    d.setAttribute('role', 'img');
    d.setAttribute('aria-label', label);
  }
  return d;
}

export function MapView(props: MapViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const lib = useRef<MapLibre | null>(null);
  const map = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(props);
  latest.current = props;
  const markers = useRef<{ waypoints: Marker[]; km: Marker[]; turn: Marker[]; highlight: Marker | null }>({ waypoints: [], km: [], turn: [], highlight: null });

  useImperativeHandle(props.ref, () => ({
    getCenter() {
      const c = map.current?.getCenter();
      return c ? [c.lng, c.lat] : undefined;
    },
    centreOn(p, zoom = 15) {
      map.current?.jumpTo({ center: [p[0], p[1]], zoom });
    },
    fitTo(points) {
      if (!map.current || !lib.current || points.length === 0) return;
      const b = new lib.current.LngLatBounds([points[0]![0], points[0]![1]], [points[0]![0], points[0]![1]]);
      for (const p of points) b.extend([p[0], p[1]]);
      map.current.fitBounds(b, { padding: 48, maxZoom: 16, duration: 600 });
    },
  }));

  // Create the map (MapLibre is lazy-loaded so it stays out of the initial bundle). Re-runs on Retry.
  useEffect(() => {
    let disposed = false;
    setReady(false);
    setFailed(null);
    // A style that neither loads nor errors must not leave the user staring at "Loading map…".
    const slow = setTimeout(() => {
      if (!disposed && !map.current?.isStyleLoaded()) setFailed('The map is taking too long to load.');
    }, STYLE_TIMEOUT_MS);
    // MapLibre 6 locates its worker relative to its own module, which breaks once a bundler
    // moves that module; pass the worker's emitted URL explicitly.
    Promise.all([import('maplibre-gl'), import('maplibre-gl/dist/maplibre-gl-worker.mjs?url')])
      .then(([ml, worker]) => {
        if (disposed || !container.current) return;
        ml.setWorkerUrl(worker.default);
        lib.current = ml;
        const p = latest.current;
        const m = new ml.Map({
          container: container.current,
          style: MAP_STYLES[p.scheme],
          center: [p.initialCenter[0], p.initialCenter[1]],
          zoom: p.initialZoom,
          attributionControl: { compact: true },
        });
        m.addControl(new ml.NavigationControl({ showCompass: false }), 'top-right');
        m.on('style.load', () => {
          clearTimeout(slow);
          addRouteLayers(m);
          syncRoute(m, latest.current);
          setFailed(null);
          setReady(true);
        });
        m.on('click', (e) => latest.current.onAddWaypoint([e.lngLat.lng, e.lngLat.lat]));
        m.on('error', (e) => {
          // Before the style has loaded, an error (style/sprite/glyph fetch) means no map at all.
          // Later errors (a missing tile or icon) are non-fatal and only logged.
          if (!m.isStyleLoaded()) setFailed('The map could not be loaded.');
          console.warn('map error', e.error?.message);
        });
        map.current = m;
      })
      .catch(() => setFailed('The map could not be loaded.'));
    return () => {
      disposed = true;
      clearTimeout(slow);
      map.current?.remove();
      map.current = null;
    };
  }, [attempt]);

  // Basemap follows the colour scheme; route layers are re-added on style.load.
  useEffect(() => {
    if (map.current && ready) map.current.setStyle(MAP_STYLES[props.scheme]);
  }, [props.scheme]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (map.current && ready) syncRoute(map.current, props);
  }, [ready, props.routeGeometry, props.gradeFeatures, props.altGeometries]); // eslint-disable-line react-hooks/exhaustive-deps

  // Waypoint markers: draggable, numbered, labelled for assistive tech.
  useEffect(() => {
    const m = map.current;
    const ml = lib.current;
    if (!m || !ml || !ready) return;
    markers.current.waypoints.forEach((mk) => mk.remove());
    const n = props.waypoints.length;
    markers.current.waypoints = props.waypoints.map((p, i) => {
      const isEnd = i === n - 1 && n > 1;
      const label = i === 0 ? 'Start' : isEnd ? 'Finish' : `Waypoint ${i + 1}`;
      const node = el(`wm-waypoint ${i === 0 ? 'wm-start' : isEnd ? 'wm-end' : ''}`, i === 0 ? 'S' : String(i + 1), `${label}, drag to move`);
      node.dataset.testid = `waypoint-${i}`;
      const mk = new ml.Marker({ element: node, draggable: true }).setLngLat([p[0], p[1]]).addTo(m);
      mk.on('dragend', () => {
        const ll = mk.getLngLat();
        latest.current.onMoveWaypoint(i, [ll.lng, ll.lat]);
      });
      return mk;
    });
  }, [ready, props.waypoints]);

  useEffect(() => {
    const m = map.current;
    const ml = lib.current;
    if (!m || !ml || !ready) return;
    markers.current.km.forEach((mk) => mk.remove());
    markers.current.turn.forEach((mk) => mk.remove());
    markers.current.km = props.kmMarkers.map((k) =>
      new ml.Marker({ element: el('wm-km', String(k.km), `Kilometre ${k.km}`) }).setLngLat([k.position[0], k.position[1]]).addTo(m),
    );
    markers.current.turn = props.turnarounds.map((p) =>
      new ml.Marker({ element: el('wm-turn', '↺', 'Turnaround') }).setLngLat([p[0], p[1]]).addTo(m),
    );
  }, [ready, props.kmMarkers, props.turnarounds]);

  useEffect(() => {
    const m = map.current;
    const ml = lib.current;
    if (!m || !ml || !ready) return;
    if (!props.highlight) {
      markers.current.highlight?.remove();
      markers.current.highlight = null;
      return;
    }
    if (!markers.current.highlight) {
      markers.current.highlight = new ml.Marker({ element: el('wm-highlight') }).setLngLat([props.highlight[0], props.highlight[1]]).addTo(m);
    } else {
      markers.current.highlight.setLngLat([props.highlight[0], props.highlight[1]]);
    }
  }, [ready, props.highlight]);

  return (
    <div className="absolute inset-0">
      <div ref={container} className="h-full w-full" data-testid="map" aria-label="Map. Click or tap to add a waypoint." role="application" />
      {!ready && !failed && (
        <p className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-slate-500 dark:text-slate-400" aria-live="polite">
          Loading map…
        </p>
      )}
      {failed && (
        <div role="alert" className="absolute inset-x-4 top-20 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          {failed} Check your connection.{' '}
          <button type="button" className="font-medium underline" onClick={() => setAttempt((a) => a + 1)}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

function addRouteLayers(m: MlMap) {
  if (!m.getSource('route')) m.addSource('route', { type: 'geojson', data: EMPTY });
  if (!m.getSource('route-grade')) m.addSource('route-grade', { type: 'geojson', data: EMPTY });
  if (!m.getSource('route-alt')) m.addSource('route-alt', { type: 'geojson', data: EMPTY });
  if (!m.getLayer('route-alt')) {
    m.addLayer({ id: 'route-alt', type: 'line', source: 'route-alt', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#64748b', 'line-width': 4, 'line-opacity': 0.45, 'line-dasharray': [1.5, 1.5] } });
  }
  if (!m.getLayer('route-casing')) {
    m.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#0f172a', 'line-width': 8, 'line-opacity': 0.35 } });
  }
  if (!m.getLayer('route-line')) {
    m.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#475569', 'line-width': 5 } });
  }
  if (!m.getLayer('route-grade')) {
    m.addLayer({ id: 'route-grade', type: 'line', source: 'route-grade', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 5 } });
  }
}

function syncRoute(m: MlMap, p: MapViewProps) {
  const route = m.getSource('route');
  const grade = m.getSource('route-grade');
  const alt = m.getSource('route-alt');
  if (alt?.type === 'geojson') {
    (alt as import('maplibre-gl').GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: (p.altGeometries ?? []).map((g) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: g.map((c) => [c[0], c[1]]) } })),
    });
  }
  if (route?.type === 'geojson') {
    (route as import('maplibre-gl').GeoJSONSource).setData(
      p.routeGeometry && p.routeGeometry.length > 1
        ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: p.routeGeometry.map((c) => [c[0], c[1]]) } }
        : EMPTY,
    );
  }
  if (grade?.type === 'geojson') {
    (grade as import('maplibre-gl').GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: (p.gradeFeatures ?? []).map((f) => ({ ...f, geometry: { ...f.geometry, coordinates: f.geometry.coordinates.map((c) => [c[0], c[1]]) } })),
    });
  }
}
