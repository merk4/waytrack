/**
 * Regression (2026-10-20): Netlify reads each function's `export const config` statically.
 * `path: API_PATHS.x` (an imported constant) was ignored on deploy, so /api/* returned 404.
 * Paths must be string literals — and must stay equal to the shared API contract.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { API_PATHS } from '../src/shared/api/contracts.ts';

const dir = new URL('../netlify/functions/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));

describe('Netlify function routing', () => {
  it('has one function per API path', () => {
    expect(files.map((f) => f.replace(/\.ts$/, '')).sort()).toEqual(Object.keys(API_PATHS).sort());
  });

  it.each(files)('%s declares its path as a string literal matching the API contract', (file) => {
    const src = readFileSync(new URL(file, dir), 'utf8');
    const m = /export const config: Config = \{ path: '([^']+)' \};/.exec(src);
    expect(m, 'config.path must be a plain string literal').not.toBeNull();
    const name = file.replace(/\.ts$/, '') as keyof typeof API_PATHS;
    expect(m![1]).toBe(API_PATHS[name]);
  });
});
