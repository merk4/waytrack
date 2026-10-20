export function formatDistance(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
}

export function formatDuration(totalS: number): string {
  const s = Math.round(totalS);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mmss = `${String(m).padStart(h > 0 ? 2 : 1, '0')}:${String(sec).padStart(2, '0')}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

export function formatPace(secPerKm: number): string {
  return `${formatDuration(secPerKm)} /km`;
}

/** "5:30" or "5" → seconds per km; undefined if not a plausible running pace. */
export function parsePace(input: string): number | undefined {
  const m = /^\s*(\d{1,2})(?::([0-5]\d))?\s*$/.exec(input);
  if (!m) return undefined;
  const s = Number(m[1]) * 60 + Number(m[2] ?? 0);
  return s >= 120 && s <= 1200 ? s : undefined;
}

export function formatGrade(pct: number): string {
  return `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

export function formatElevation(m: number): string {
  return `${Math.round(m)} m`;
}
