import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..');
const setupDir = join(repoRoot, 'tests', 'setup');

/** Every module specifier a file imports or re-exports STATICALLY. A computed `await import(path)` has
 *  no literal specifier and is deliberately not matched — that is the discovery form we want. */
function staticImports(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;\n]*?\bfrom\s*'([^']+)'/g)) out.push(m[1]!);
  for (const m of source.matchAll(/(?:^|\n)\s*import\s*'([^']+)'/g)) out.push(m[1]!);
  for (const m of source.matchAll(/\brequire\(\s*'([^']+)'\s*\)/g)) out.push(m[1]!);
  return out;
}

/** A vitest setup file runs before EVERY test file, so anything it imports statically is a dependency
 *  of the whole core suite. Naming a plugin there means renaming, moving or unbundling that plugin
 *  stops thousands of unrelated core tests from booting at all — which is exactly what a static import
 *  of the agents prompt catalog used to do. Individual tests may import a plugin freely (~270 do, and
 *  they are how plugin behaviour is covered); only the global setup may not.
 *
 *  Not a dependency-cruiser rule: `npm run depcruise` scans `src web plugins` and does not look at
 *  tests/ at all, and widening `core-not-to-plugins` to `^tests/` would forbid every one of those
 *  legitimate plugin tests. The narrow invariant is cheapest to enforce right here. */
describe('vitest setup files', () => {
  it('exist and are the ones the config loads', () => {
    const config = readFileSync(join(repoRoot, 'vitest.config.ts'), 'utf8');
    const declared = [...config.matchAll(/'(tests\/setup\/[^']+)'/g)].map((m) => m[1]!);
    expect(declared.length).toBeGreaterThan(0);
    for (const file of declared) expect(existsSync(join(repoRoot, file))).toBe(true);
  });

  it('never import a plugin statically', () => {
    const offenders: string[] = [];
    for (const entry of readdirSync(setupDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(ts|mts|js|mjs)$/.test(entry.name)) continue;
      for (const spec of staticImports(readFileSync(join(setupDir, entry.name), 'utf8'))) {
        if (/(^|\/)plugins\//.test(spec)) offenders.push(`${entry.name} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
