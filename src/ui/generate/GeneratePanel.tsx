import { useId } from 'react';
import type { Terrain } from '../../domain/route/types.ts';
import type { GeneratedRouteDto } from '../../shared/api/contracts.ts';
import { formatDistance, formatElevation } from '../format.ts';
import type { GenerateState } from '../hooks/useGenerate.ts';

export interface GenerateOptions {
  distanceKm: number;
  terrain: Terrain;
  targetGainM: number;
  avoidBusyRoads: boolean;
  preferPavements: boolean;
  avoidLaps: boolean;
}

export const DISTANCE_CHIPS = [5, 8, 10, 12, 15, 21.1] as const;

export const isGenerateOptions = (v: unknown): v is GenerateOptions => {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.distanceKm === 'number' &&
    o.distanceKm >= 1 &&
    o.distanceKm <= 50 &&
    (o.terrain === 'flat' || o.terrain === 'any' || o.terrain === 'hilly') &&
    typeof o.targetGainM === 'number' &&
    typeof o.avoidBusyRoads === 'boolean' &&
    typeof o.preferPavements === 'boolean' &&
    (o.avoidLaps === undefined || typeof o.avoidLaps === 'boolean')
  );
};

const STAGES = [
  ['scan', 'Scanning terrain'],
  ['plan', 'Planning routes'],
  ['route', 'Routing on real paths'],
  ['compose', 'Fitting to your distance'],
  ['screen', 'Scoring candidates'],
  ['elevation', 'Checking elevation'],
] as const;

const KIND_LABEL: Record<GeneratedRouteDto['kind'], string> = {
  loop: 'Loop',
  'out-and-back': 'Out & back',
  laps: 'Repeated laps',
  'loop+detour': 'Loop',
};

interface Props {
  options: GenerateOptions;
  onOptions(o: GenerateOptions): void;
  state: GenerateState;
  onGenerate(): void;
  onCancel(): void;
  onAnother(): void;
  selected: number;
  onSelect(i: number): void;
}

function Toggle(props: { label: string; help: string; checked: boolean; onChange(v: boolean): void }) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-3">
      <label htmlFor={id} className="text-sm">
        <span className="block font-medium text-slate-900 dark:text-white">{props.label}</span>
        <span className="block text-xs text-slate-600 dark:text-slate-400">{props.help}</span>
      </label>
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
        className="mt-1 h-6 w-11 shrink-0 cursor-pointer appearance-none rounded-full bg-slate-300 transition-colors before:block before:h-5 before:w-5 before:translate-x-0.5 before:translate-y-0.5 before:rounded-full before:bg-white before:shadow before:transition-transform checked:bg-emerald-600 checked:before:translate-x-5.5 dark:bg-slate-600"
      />
    </div>
  );
}

export function GeneratePanel({ options, onOptions, state, onGenerate, onCancel, onAnother, selected, onSelect }: Props) {
  const set = <K extends keyof GenerateOptions>(k: K, v: GenerateOptions[K]) => onOptions({ ...options, [k]: v });
  const customId = useId();
  const gainId = useId();
  const running = state.status === 'running';
  const isChip = (DISTANCE_CHIPS as readonly number[]).includes(options.distanceKm);

  return (
    <section aria-label="Generate a route" className="space-y-4">
      <fieldset disabled={running} className="space-y-4">
        <div>
          <legend className="mb-2 text-sm font-medium text-slate-900 dark:text-white">How far?</legend>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Distance">
            {DISTANCE_CHIPS.map((km) => (
              <button
                key={km}
                type="button"
                role="radio"
                aria-checked={options.distanceKm === km}
                onClick={() => set('distanceKm', km)}
                className={`min-h-11 rounded-full px-4 text-sm font-medium ${options.distanceKm === km ? 'bg-emerald-700 text-white dark:bg-emerald-600' : 'bg-slate-100 text-slate-800 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700'}`}
              >
                {km === 21.1 ? 'Half (21.1)' : km} km
              </button>
            ))}
            <label htmlFor={customId} className="flex min-h-11 items-center gap-1 rounded-full bg-slate-100 pl-4 pr-2 text-sm text-slate-800 dark:bg-slate-800 dark:text-slate-100">
              Other
              <input
                id={customId}
                type="number"
                min={1}
                max={50}
                step={0.5}
                inputMode="decimal"
                value={isChip ? '' : options.distanceKm}
                placeholder="km"
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (v >= 1 && v <= 50) set('distanceKm', v);
                }}
                className={`w-16 rounded-lg bg-transparent px-1 py-1 text-right tabular-nums ${isChip ? '' : 'font-semibold'}`}
                aria-label="Custom distance in kilometres"
              />
            </label>
          </div>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-slate-900 dark:text-white" id="terrain-label">
            Terrain
          </p>
          <div className="grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800" role="radiogroup" aria-labelledby="terrain-label">
            {(['flat', 'any', 'hilly'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={options.terrain === t}
                onClick={() => set('terrain', t)}
                className={`min-h-10 rounded-lg text-sm font-medium ${options.terrain === t ? 'bg-white text-slate-900 shadow dark:bg-slate-600 dark:text-white' : 'text-slate-700 dark:text-slate-300'}`}
              >
                {t === 'flat' ? 'Flat' : t === 'any' ? "Don't mind" : 'Hilly'}
              </button>
            ))}
          </div>
          {options.terrain === 'hilly' && (
            <label htmlFor={gainId} className="mt-2 flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
              Target climb
              <input
                id={gainId}
                type="number"
                min={10}
                max={3000}
                step={10}
                value={options.targetGainM}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (v >= 10 && v <= 3000) set('targetGainM', v);
                }}
                className="min-h-11 w-24 rounded-xl border border-slate-300 bg-white px-3 tabular-nums dark:border-slate-600 dark:bg-slate-800 dark:text-white"
              />
              m
            </label>
          )}
        </div>

        <div className="space-y-3">
          <Toggle label="Avoid busy roads" help="Steer clear of main roads and multi-lane or 50 km/h streets." checked={options.avoidBusyRoads} onChange={(v) => set('avoidBusyRoads', v)} />
          <Toggle
            label="Prefer pavements"
            help="Favour pedestrian streets, footpaths and roads mapped with a pavement. Map data is incomplete in places."
            checked={options.preferPavements}
            onChange={(v) => set('preferPavements', v)}
          />
          <Toggle
            label="No repeated laps"
            help="Never run the same stretch twice over. A single out-and-back (there and back the same way) can still appear."
            checked={options.avoidLaps === true}
            onChange={(v) => set('avoidLaps', v)}
          />
        </div>
      </fieldset>

      {running ? (
        <div className="space-y-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700" aria-live="polite">
          <ol className="space-y-1 text-sm">
            {STAGES.map(([stage, label]) => {
              const currentIdx = STAGES.findIndex(([s]) => s === state.progress?.stage);
              const idx = STAGES.findIndex(([s]) => s === stage);
              const status = currentIdx === -1 ? (idx === 0 ? 'active' : 'todo') : idx < currentIdx ? 'done' : idx === currentIdx ? 'active' : 'todo';
              return (
                <li key={stage} className={status === 'todo' ? 'text-slate-400 dark:text-slate-500' : 'text-slate-900 dark:text-white'}>
                  <span aria-hidden="true" className="inline-block w-5">
                    {status === 'done' ? '✓' : status === 'active' ? '›' : '·'}
                  </span>
                  {status === 'active' && state.progress ? state.progress.message : label}
                </li>
              );
            })}
          </ol>
          <button type="button" className="btn-link" onClick={onCancel}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className="btn-primary w-full" onClick={onGenerate} data-testid="generate">
          Find {options.distanceKm} km routes
        </button>
      )}

      {state.status === 'error' && (
        <div role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          {state.error.message}{' '}
          <button type="button" className="font-medium underline" onClick={onGenerate}>
            Try again
          </button>
        </div>
      )}

      {state.status === 'success' && (
        <div className="space-y-2">
          <ul className="space-y-2" aria-label="Route options">
            {state.result.routes.map((r, i) => (
              <li key={r.id}>
                <button
                  type="button"
                  aria-pressed={selected === i}
                  onClick={() => onSelect(i)}
                  data-testid={`route-option-${i}`}
                  className={`w-full rounded-xl border p-3 text-left ${selected === i ? 'border-emerald-600 bg-emerald-50 ring-1 ring-emerald-600 dark:bg-emerald-950' : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800'}`}
                >
                  <span className="flex items-baseline justify-between">
                    <span className="font-semibold text-slate-900 dark:text-white">{i === 0 ? 'Best match' : `Alternative ${i}`}</span>
                    <span className="text-xs text-slate-600 dark:text-slate-400">{KIND_LABEL[r.kind]}</span>
                  </span>
                  <span className="mt-1 block text-sm tabular-nums text-slate-700 dark:text-slate-300">
                    {formatDistance(r.stats.distanceM)} · ↑ {formatElevation(r.stats.gainM)} · steepest {r.stats.maxGradePct.toFixed(1)}%
                  </span>
                  <span className="block text-xs text-slate-600 dark:text-slate-400">
                    Busy roads {Math.round(r.roadMix.busyShare * 100)}% · Pavement {Math.round(r.roadMix.pavementShare * 100)}%
                    {r.turnarounds > 0 ? ` · ${r.turnarounds} turnaround${r.turnarounds > 1 ? 's' : ''}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {state.result.diagnostics.startMovedM !== undefined && (
            <p className="text-xs text-amber-800 dark:text-amber-300" role="status">
              Your start wasn't on a runnable path (it was {state.result.diagnostics.startMovedM} m away, maybe in water), so the routes start from the nearest path. The
              start marker has moved there.
            </p>
          )}
          {state.result.diagnostics.elevationFallback && (
            <p className="text-xs text-amber-800 dark:text-amber-300">The elevation service was unavailable, so climb figures are approximate (from the routing data).</p>
          )}
          {state.result.diagnostics.stoppedEarly && (
            <p className="text-xs text-slate-600 dark:text-slate-400">The routing service is busy, so fewer options were explored. Try again in a minute for more.</p>
          )}
          <button type="button" className="btn-link" onClick={onAnother}>
            Show different routes
          </button>
        </div>
      )}
    </section>
  );
}
