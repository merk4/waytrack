import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MIN_WAYPOINT_SPACING_M } from '../application/planner/plannerState.ts';
import type { RoutedShape } from '../application/ports.ts';
import { distance, pointAt } from '../domain/geo/distance.ts';
import type { LngLat } from '../domain/geo/types.ts';
import { kmMarkers } from '../domain/statistics/pace.ts';
import { AnalysisPanel } from './analysis/AnalysisPanel.tsx';
import { ApiError, toRoutedShape } from './api/client.ts';
import { DEFAULT_PACE_S_PER_KM, DEFAULT_VIEW } from './config.ts';
import { GeneratePanel, isGenerateOptions, type GenerateOptions } from './generate/GeneratePanel.tsx';
import { useGenerate } from './hooks/useGenerate.ts';
import { usePlannedRoute } from './hooks/usePlannedRoute.ts';
import { usePlanner } from './hooks/usePlanner.ts';
import { useColorScheme, useStoredState } from './hooks/usePreferences.ts';
import { useRouteAnalysis } from './hooks/useRouteAnalysis.ts';
import { MapView, type MapHandle } from './map/MapView.tsx';
import { gradeSegments, turnaroundMarkers } from './map/routeFeatures.ts';
import { PlannerToolbar } from './planner/PlannerToolbar.tsx';
import { StartScreen } from './planner/StartScreen.tsx';
import { WaypointList } from './planner/WaypointList.tsx';

type Tab = 'generate' | 'draw';

const isPace = (v: unknown): v is number => typeof v === 'number' && v >= 120 && v <= 1200;
const isLngLat = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) && Math.abs(v[0]) <= 180 && Math.abs(v[1]) <= 90;
const isTab = (v: unknown): v is Tab => v === 'generate' || v === 'draw';

/** A waypoint further than this from where the route passes gets a notice. */
const OFF_PATH_NOTICE_M = 50;

const DEFAULT_OPTIONS: GenerateOptions = { distanceKm: 10, terrain: 'flat', targetGainM: 150, avoidBusyRoads: true, preferPavements: false, avoidLaps: false };

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong while routing.';
}

export function App() {
  const { state, dispatch } = usePlanner();
  const scheme = useColorScheme();
  const [pace, setPace] = useStoredState('waymark.pace', DEFAULT_PACE_S_PER_KM, isPace);
  const [lastStart, setLastStart] = useStoredState<[number, number] | null>('waymark.lastStart', null, (v): v is [number, number] | null => v === null || isLngLat(v));
  const [tab, setTab] = useStoredState<Tab>('waymark.tab', 'generate', isTab);
  const [options, setOptions] = useStoredState<GenerateOptions>('waymark.generate', DEFAULT_OPTIONS, isGenerateOptions);
  const [start, setStartState] = useState<LngLat | undefined>();
  const [seed, setSeed] = useState(1);
  const [selected, setSelected] = useState(0);
  const [hover, setHover] = useState<number | undefined>();
  const [notice, setNotice] = useState<string | null>(null);
  const map = useRef<MapHandle>(null);
  const gen = useGenerate();

  const planned = usePlannedRoute(state.waypoints);
  const generated: RoutedShape | undefined = useMemo(
    () => (gen.state.status === 'success' ? toRoutedShape(gen.state.result.routes[selected]?.route ?? gen.state.result.routes[0]!.route) : undefined),
    [gen.state, selected],
  );
  const activeShape = tab === 'generate' ? generated : planned.route;
  const analysis = useRouteAnalysis(activeShape);

  const resetGenerate = gen.reset;
  const setStart = useCallback(
    (p: LngLat) => {
      setStartState(p);
      setLastStart([p[0], p[1]]);
      resetGenerate();
    },
    [resetGenerate, setLastStart],
  );

  // Drawing starts from the chosen start point.
  useEffect(() => {
    if (tab === 'draw' && start && state.waypoints.length === 0) dispatch({ type: 'add', point: start });
  }, [tab, start, state.waypoints.length, dispatch]);

  const runGenerate = (nextSeed: number) => {
    if (!start) return;
    setSeed(nextSeed);
    setSelected(0);
    setHover(undefined);
    void gen.run({
      start: [start[0], start[1]],
      distanceM: Math.round(options.distanceKm * 1000),
      preferences: {
        terrain: options.terrain,
        avoidBusyRoads: options.avoidBusyRoads,
        preferPavements: options.preferPavements,
        avoidLaps: options.avoidLaps === true,
        ...(options.terrain === 'hilly' ? { targetGainM: options.targetGainM } : {}),
      },
      seed: nextSeed,
    });
  };

  // Fit the map to a newly generated or selected route.
  useEffect(() => {
    if (tab === 'generate' && generated) map.current?.fitTo(generated.geometry);
  }, [tab, generated]);

  // Routes start where the start snaps onto the path network; show the marker there
  // (a start in water or a field otherwise sits away from the route's beginning).
  const generatedStart = gen.state.status === 'success' ? gen.state.result.start : undefined;
  useEffect(() => {
    if (generatedStart) setStartState([generatedStart[0], generatedStart[1]]);
  }, [generatedStart]);

  // Draw mode: points the router had to move far to reach a path (e.g. tapped in water).
  const farPoints = useMemo(() => {
    const r = planned.route;
    if (!r) return [];
    return r.waypoints.flatMap((w, i) => {
      const tapped = state.waypoints[i];
      const moved = tapped ? distance(tapped, w.position) : 0;
      return moved > OFF_PATH_NOTICE_M ? [{ index: i, moved: Math.round(moved) }] : [];
    });
  }, [planned.route, state.waypoints]);

  // Memoised: MapView re-creates markers/sources when these change identity.
  const mapWaypoints = useMemo(() => (tab === 'generate' ? (start ? [start] : []) : state.waypoints), [tab, start, state.waypoints]);
  const alternatives = useMemo(
    () => (tab === 'generate' && gen.state.status === 'success' ? gen.state.result.routes.filter((_, i) => i !== selected).map((r) => r.route.geometry) : []),
    [tab, gen.state, selected],
  );

  const outcome = analysis.data;
  const view = useMemo(() => {
    const a = outcome?.analysis;
    if (!a) return undefined;
    const line = a.geometry.line;
    return {
      gradeFeatures: gradeSegments(line, a.profile).features,
      km: kmMarkers(line),
      turnarounds: turnaroundMarkers(
        a.geometry.shape.turnarounds.map((t) => t.position),
        mapWaypoints,
      ),
    };
  }, [outcome, mapWaypoints]);

  const highlight = hover !== undefined && outcome ? pointAt(outcome.analysis.geometry.line, hover) : undefined;

  return (
    <div className="fixed inset-0 flex flex-col md:flex-row-reverse">
      <main className="relative min-h-0 flex-1">
        <MapView
          ref={map}
          scheme={scheme}
          initialCenter={lastStart ?? DEFAULT_VIEW.center}
          initialZoom={lastStart ? 14 : DEFAULT_VIEW.zoom}
          waypoints={mapWaypoints}
          routeGeometry={activeShape?.geometry}
          altGeometries={alternatives}
          gradeFeatures={view?.gradeFeatures}
          kmMarkers={view?.km ?? []}
          turnarounds={view?.turnarounds ?? []}
          highlight={highlight}
          onAddWaypoint={(p) => {
            if (!start) return setStart(p);
            if (tab === 'generate') setStart(p);
            else dispatch({ type: 'add', point: p });
          }}
          onMoveWaypoint={(index, point) => (tab === 'generate' ? setStart(point) : dispatch({ type: 'move', index, point }))}
        />
      </main>

      <aside
        aria-label="Route planner"
        className="z-10 max-h-[55dvh] overflow-y-auto rounded-t-2xl border-t border-slate-200 bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-[0_-8px_24px_rgba(0,0,0,0.12)] md:max-h-none md:w-[420px] md:rounded-none md:border-r md:border-t-0 md:shadow-none dark:border-slate-700 dark:bg-slate-900"
      >
        <header className="mb-4 flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="h-7 w-7" />
          <span className="text-lg font-semibold tracking-tight text-slate-900 dark:text-white">Waymark</span>
          {start && (
            <button type="button" className="btn-link ml-auto" onClick={() => {
              setStartState(undefined);
              gen.reset();
              dispatch({ type: 'clear' });
            }}>
              Change start
            </button>
          )}
        </header>

        {!start ? (
          <StartScreen
            onStart={(p) => {
              setStart(p);
              map.current?.centreOn(p, 15);
            }}
          />
        ) : (
          <div className="space-y-4">
            <div role="tablist" aria-label="How to make a route" className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
              {(['generate', 'draw'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => {
                    setTab(t);
                    setHover(undefined);
                  }}
                  className={`min-h-10 rounded-lg text-sm font-medium ${tab === t ? 'bg-white text-slate-900 shadow dark:bg-slate-600 dark:text-white' : 'text-slate-700 dark:text-slate-300'}`}
                >
                  {t === 'generate' ? 'Find a route' : 'Draw my own'}
                </button>
              ))}
            </div>

            {tab === 'generate' ? (
              <GeneratePanel
                options={options}
                onOptions={setOptions}
                state={gen.state}
                onGenerate={() => runGenerate(seed)}
                onCancel={gen.cancel}
                onAnother={() => runGenerate(seed + 1)}
                selected={selected}
                onSelect={(i) => {
                  setSelected(i);
                  setHover(undefined);
                }}
              />
            ) : (
              <>
                <PlannerToolbar
                  state={state}
                  dispatch={dispatch}
                  distanceM={planned.distanceM}
                  isEstimate={planned.isEstimate}
                  routing={planned.pendingLegs > 0}
                  onAddAtCentre={() => {
                    const c = map.current?.getCenter();
                    const last = state.waypoints[state.waypoints.length - 1];
                    if (!c) return;
                    if (last && distance(last, c) < MIN_WAYPOINT_SPACING_M) {
                      setNotice('The map centre is already your last point. Move the map (arrow keys work when it has focus), then add.');
                      return;
                    }
                    setNotice(null);
                    dispatch({ type: 'add', point: c });
                  }}
                />
                <p aria-live="polite" className="text-sm text-slate-700 empty:hidden dark:text-slate-300">
                  {notice}
                </p>
                {planned.error !== undefined && (
                  <div role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
                    {errorText(planned.error)}{' '}
                    <button type="button" className="font-medium underline" onClick={planned.retry}>
                      Retry
                    </button>
                  </div>
                )}
                {farPoints.length > 0 && (
                  <p role="status" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                    {farPoints.map((f) => `${f.index === 0 ? 'The start' : `Point ${f.index + 1}`} is ${f.moved} m from the nearest path`).join('; ')} (in water or off the
                    path network?), so the route uses the nearest path. Drag the point onto a street or path to fix it.
                  </p>
                )}
                {outcome && outcome.analysis.geometry.roadMix.waterCrossingM > 0 && (
                  <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
                    This route crosses water by ferry or ford ({Math.round(outcome.analysis.geometry.roadMix.waterCrossingM)} m), which you can't run. Move or remove
                    points so it stays on land.
                  </p>
                )}
                <WaypointList waypoints={state.waypoints} failedLegs={planned.failedLegs} dispatch={dispatch} />
              </>
            )}

            {activeShape && analysis.isPending && (
              <p className="text-sm text-slate-600 dark:text-slate-400" aria-live="polite">
                Calculating elevation…
              </p>
            )}
            {activeShape && analysis.isError && (
              <div role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
                Couldn't load elevation: {errorText(analysis.error)}{' '}
                <button type="button" className="font-medium underline" onClick={() => void analysis.refetch()}>
                  Retry
                </button>
              </div>
            )}
            {outcome?.approximate && (
              <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200" role="status">
                The elevation service is unavailable right now, so these climb figures are approximate (from the routing data). They will be exact again once it is back.
              </p>
            )}
            {outcome && activeShape && (
              <AnalysisPanel
                analysis={outcome.analysis}
                instructions={activeShape.instructions}
                paceSecPerKm={pace}
                onPaceChange={setPace}
                hoverDistance={hover}
                onHover={setHover}
              />
            )}
          </div>
        )}

        <footer className="mt-6 space-y-0.5 text-[11px] leading-snug text-slate-500 dark:text-slate-400">
          <p>Routing: powered by GraphHopper API. Search: © OpenStreetMap contributors (Nominatim, Photon).</p>
          <p>
            Elevation: Copernicus DEM GLO-90 © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and
            ESA. Map: OpenFreeMap © OpenMapTiles, © OpenStreetMap contributors.
          </p>
        </footer>
      </aside>
    </div>
  );
}
