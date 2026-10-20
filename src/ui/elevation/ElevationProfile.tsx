import { useMemo, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import type { ElevationProfile as Profile } from '../../domain/elevation/profile.ts';
import { formatDistance, formatElevation, formatGrade } from '../format.ts';
import { gradeAt } from '../map/routeFeatures.ts';

const W = 1000;
const H = 160;
const PAD = 8;
/** Never stretch less than this many metres over the full height (flat routes stay flat). */
const MIN_RANGE_M = 20;

interface Props {
  profile: Profile;
  hoverDistance: number | undefined;
  onHover(d: number | undefined): void;
}

export function ElevationProfile({ profile, hoverDistance, onHover }: Props) {
  const ref = useRef<SVGSVGElement>(null);
  const total = profile.distances[profile.distances.length - 1] ?? 0;
  const e = profile.smoothed;

  const { area, line, lo, hi } = useMemo(() => {
    const min = Math.min(...e);
    const max = Math.max(...e);
    const span = Math.max(MIN_RANGE_M, max - min);
    const lo = (min + max) / 2 - span / 2;
    const hi = lo + span;
    const pts = profile.distances.map((d, i) => [(d / (total || 1)) * W, H - PAD - ((e[i]! - lo) / span) * (H - 2 * PAD)] as const);
    const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
    return { area: `${line}L${W},${H}L0,${H}Z`, line, lo, hi };
  }, [profile, e, total]);

  const at = (d: number) => {
    let i = profile.distances.findIndex((x) => x >= d);
    if (i < 0) i = e.length - 1;
    return e[i]!;
  };

  const fromPointer = (ev: PointerEvent<SVGSVGElement>) => {
    const r = ref.current!.getBoundingClientRect();
    onHover(Math.max(0, Math.min(total, ((ev.clientX - r.left) / r.width) * total)));
  };

  const onKey = (ev: KeyboardEvent<SVGSVGElement>) => {
    const cur = hoverDistance ?? 0;
    const step = ev.shiftKey ? 1000 : 100;
    const next =
      ev.key === 'ArrowRight' ? cur + step : ev.key === 'ArrowLeft' ? cur - step : ev.key === 'Home' ? 0 : ev.key === 'End' ? total : ev.key === 'Escape' ? undefined : null;
    if (next === null) return;
    ev.preventDefault();
    onHover(next === undefined ? undefined : Math.max(0, Math.min(total, next)));
  };

  const hx = hoverDistance === undefined ? undefined : (hoverDistance / (total || 1)) * W;
  const valueText =
    hoverDistance === undefined
      ? 'Use arrow keys to explore the profile'
      : `${formatDistance(hoverDistance)}, ${formatElevation(at(hoverDistance))}, grade ${formatGrade(gradeAt(profile, hoverDistance))}`;

  return (
    <figure className="space-y-1">
      <div className="relative">
        <svg
          ref={ref}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="h-36 w-full touch-none rounded-lg bg-slate-100 outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:bg-slate-800"
          role="slider"
          tabIndex={0}
          aria-label="Elevation profile"
          aria-valuemin={0}
          aria-valuemax={Math.round(total)}
          aria-valuenow={Math.round(hoverDistance ?? 0)}
          aria-valuetext={valueText}
          data-testid="elevation-profile"
          onPointerMove={fromPointer}
          onPointerDown={fromPointer}
          onPointerLeave={(ev) => ev.pointerType === 'mouse' && onHover(undefined)}
          onKeyDown={onKey}
        >
          <path d={area} className="fill-emerald-500/25" />
          <path d={line} className="fill-none stroke-emerald-700 dark:stroke-emerald-400" strokeWidth={2} vectorEffect="non-scaling-stroke" />
          {hx !== undefined && <line x1={hx} x2={hx} y1={0} y2={H} className="stroke-slate-900 dark:stroke-white" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
        </svg>
        <span className="pointer-events-none absolute left-2 top-1 text-xs text-slate-600 dark:text-slate-300">{formatElevation(hi)}</span>
        <span className="pointer-events-none absolute bottom-1 left-2 text-xs text-slate-600 dark:text-slate-300">{formatElevation(lo)}</span>
      </div>
      <figcaption className="min-h-5 text-sm tabular-nums text-slate-700 dark:text-slate-300" aria-hidden="true">
        {hoverDistance === undefined ? 'Touch or hover the profile to find that point on the map.' : valueText}
      </figcaption>
    </figure>
  );
}
