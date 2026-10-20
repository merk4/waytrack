/**
 * Enforces the layering rules from the spec (§5). Each layer may import only the
 * layers listed for it (and npm packages only where `packages` is true).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

type Layer = 'domain' | 'application' | 'shared' | 'infrastructure' | 'providers' | 'server' | 'ui' | 'netlify';

const RULES: Record<Layer, { may: Layer[]; packages: boolean | string[] }> = {
  domain: { may: ['domain'], packages: false },
  application: { may: ['domain', 'application'], packages: false },
  shared: { may: ['domain', 'shared'], packages: ['zod'] },
  infrastructure: { may: ['domain', 'application', 'infrastructure'], packages: false },
  providers: { may: ['domain', 'application', 'infrastructure', 'providers'], packages: ['zod', 'geotiff'] },
  server: { may: ['domain', 'application', 'shared', 'infrastructure', 'providers', 'server'], packages: true },
  ui: { may: ['domain', 'application', 'shared', 'ui'], packages: true },
  netlify: { may: ['server', 'shared'], packages: ['@netlify/functions'] },
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

function importsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  return [...src.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]!);
}

function layerOf(file: string): Layer | undefined {
  const rel = relative(ROOT, file).split(sep);
  if (rel[0] === 'netlify') return 'netlify';
  if (rel[0] !== 'src') return undefined;
  return rel[1] as Layer;
}

const packageName = (spec: string) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!);

describe('architecture', () => {
  const files = [...sourceFiles(SRC), ...sourceFiles(join(ROOT, 'netlify'))];

  it('every source file belongs to a known layer', () => {
    expect(files.filter((f) => !(layerOf(f)! in RULES)).map((f) => relative(ROOT, f))).toEqual([]);
  });

  it('layers import only what they are allowed to', () => {
    const violations = files.flatMap((f) => {
      const layer = layerOf(f)!;
      const rule = RULES[layer];
      return importsOf(f)
        .filter((spec) => {
          if (spec.startsWith('.')) return !rule.may.includes(layerOf(join(dirname(f), spec))!);
          if (spec.startsWith('node:')) return layer !== 'server';
          return rule.packages === true ? false : rule.packages === false || !rule.packages.includes(packageName(spec));
        })
        .map((spec) => `${relative(ROOT, f)} (${layer}) → ${spec}`);
    });
    expect(violations).toEqual([]);
  });

  it('no `any` in source', () => {
    const offenders = files.filter((f) => /(:\s*any\b|as\s+any\b|<any>)/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it('no secrets in client-exposed env (VITE_*) anywhere in source', () => {
    const offenders = files.filter((f) => /VITE_[A-Z_]*(KEY|SECRET|TOKEN)/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
