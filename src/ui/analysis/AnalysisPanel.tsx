import { useMemo, useState } from 'react';
import type { RouteAnalysis } from '../../application/analyseRoute/analyseRoute.ts';
import type { Instruction } from '../../domain/route/types.ts';
import { gradeAdjustedSplits } from '../../domain/statistics/pace.ts';
import { ElevationProfile } from '../elevation/ElevationProfile.tsx';
import { formatDistance, formatDuration, formatElevation, formatGrade, formatPace, parsePace } from '../format.ts';
import { GRADE_COLOURS, GRADE_LABELS, type GradeClass } from '../map/routeFeatures.ts';

interface Props {
  analysis: RouteAnalysis;
  instructions: readonly Instruction[];
  paceSecPerKm: number;
  onPaceChange(s: number): void;
  hoverDistance: number | undefined;
  onHover(d: number | undefined): void;
}

function Stat({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="rounded-xl bg-slate-100 px-3 py-2 dark:bg-slate-800">
      <dt className="text-xs text-slate-600 dark:text-slate-400">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums text-slate-900 dark:text-white" {...(testId ? { 'data-testid': testId } : {})}>
        {value}
      </dd>
    </div>
  );
}

export function AnalysisPanel({ analysis, instructions, paceSecPerKm, onPaceChange, hoverDistance, onHover }: Props) {
  const { stats, profile } = analysis;
  const [paceText, setPaceText] = useState(formatDuration(paceSecPerKm));
  const paceValid = parsePace(paceText) !== undefined;
  const splits = useMemo(() => gradeAdjustedSplits(profile, paceSecPerKm), [profile, paceSecPerKm]);
  const finish = splits.reduce((a, s) => a + s.seconds, 0);
  const steepest = stats.steepest;

  return (
    <section aria-label="Route analysis" className="space-y-4">
      <dl className="grid grid-cols-3 gap-2">
        <Stat label="Distance" value={formatDistance(stats.distanceM)} />
        <Stat label="Gain" value={`↑ ${formatElevation(stats.gainM)}`} testId="stat-gain" />
        <Stat label="Loss" value={`↓ ${formatElevation(stats.lossM)}`} />
        <Stat label="Lowest" value={formatElevation(stats.minElevationM)} />
        <Stat label="Highest" value={formatElevation(stats.maxElevationM)} />
        <Stat label="Steepest 500 m" value={formatGrade(steepest.gradePct)} />
        <Stat label="Steepest 200 m" value={`${stats.maxGradePct.toFixed(1)}%`} testId="stat-max-grade" />
        <Stat label="Steep (≥ 3%)" value={`${Math.round(stats.steepShare * 100)}% of route`} testId="stat-steep-share" />
      </dl>

      <ElevationProfile profile={profile} hoverDistance={hoverDistance} onHover={onHover} />

      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-700 dark:text-slate-300" aria-label="Gradient colours">
        {(Object.keys(GRADE_COLOURS) as GradeClass[]).map((g) => (
          <li key={g} className="flex items-center gap-1">
            <span className="inline-block h-2 w-4 rounded" style={{ background: GRADE_COLOURS[g] }} aria-hidden="true" />
            {GRADE_LABELS[g]}
          </li>
        ))}
      </ul>

      <div className="flex items-end gap-3">
        <label className="flex flex-col text-sm text-slate-700 dark:text-slate-300">
          Your flat pace (min:sec per km)
          <input
            inputMode="numeric"
            value={paceText}
            onChange={(e) => {
              setPaceText(e.target.value);
              const s = parsePace(e.target.value);
              if (s !== undefined) onPaceChange(s);
            }}
            aria-invalid={!paceValid}
            aria-describedby="pace-help"
            className="mt-1 min-h-11 w-28 rounded-xl border border-slate-300 bg-white px-3 text-base tabular-nums text-slate-900 aria-invalid:border-red-600 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
          />
        </label>
        <p className="pb-2 text-sm text-slate-700 dark:text-slate-300">
          Estimated finish <strong className="text-lg tabular-nums text-slate-900 dark:text-white" data-testid="finish-time">{formatDuration(finish)}</strong>
        </p>
      </div>
      <p id="pace-help" className={`-mt-2 text-xs ${paceValid ? 'text-slate-500 dark:text-slate-400' : 'text-red-700 dark:text-red-300'}`}>
        {paceValid ? 'Splits are adjusted for gradient (Minetti model).' : 'Enter a pace between 2:00 and 20:00, e.g. 5:30.'}
      </p>

      <details className="rounded-xl border border-slate-200 dark:border-slate-700">
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-slate-800 dark:text-slate-200">Splits at {formatPace(paceSecPerKm)}</summary>
        <table className="w-full text-sm tabular-nums">
          <thead className="text-left text-xs text-slate-600 dark:text-slate-400">
            <tr>
              <th className="px-3 py-1 font-medium">Km</th>
              <th className="px-3 py-1 font-medium">Time</th>
              <th className="px-3 py-1 font-medium">Climb</th>
            </tr>
          </thead>
          <tbody className="text-slate-800 dark:text-slate-200">
            {splits.map((s) => (
              <tr key={s.km} className="border-t border-slate-200 dark:border-slate-700">
                <td className="px-3 py-1">{s.distanceM < 999 ? `${s.km} (${formatDistance(s.distanceM)})` : s.km}</td>
                <td className="px-3 py-1">{formatDuration(s.seconds)}</td>
                <td className="px-3 py-1">
                  ↑{Math.round(s.gainM)} ↓{Math.round(s.lossM)} m
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      {instructions.length > 0 && (
        <details className="rounded-xl border border-slate-200 dark:border-slate-700">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-slate-800 dark:text-slate-200">Turn-by-turn ({instructions.length})</summary>
          <ol className="divide-y divide-slate-200 text-sm dark:divide-slate-700">
            {instructions.map((i, n) => (
              <li key={n} className="flex justify-between gap-3 px-3 py-1.5 text-slate-800 dark:text-slate-200">
                <span>{i.text}</span>
                {i.distanceM > 0 && <span className="shrink-0 tabular-nums text-slate-500 dark:text-slate-400">{formatDistance(i.distanceM)}</span>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
