import type { Logger } from '../../application/ports.ts';

const SECRET_KEY = /(key|token|secret|password|authorization|apikey)/i;
const SECRET_IN_TEXT = /([?&](?:key|apikey|access_token|token)=)[^&\s"']+/gi;

/** Removes credential-looking fields and query parameters. Applied to every log line. */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.replace(SECRET_IN_TEXT, '$1[REDACTED]');
  if (depth > 5 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1)]),
  );
}

/** One JSON line per event on stdout/stderr (Netlify function logs). */
export function createConsoleLogger(base: Record<string, unknown> = {}): Logger {
  const line = (level: string, event: string, data?: Record<string, unknown>) =>
    JSON.stringify(redact({ level, event, ...base, ...data, at: new Date().toISOString() }));
  return {
    info: (e, d) => console.log(line('info', e, d)),
    warn: (e, d) => console.warn(line('warn', e, d)),
    error: (e, d) => console.error(line('error', e, d)),
  };
}
