import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..');
const srcRoot = join(repoRoot, 'src');

/** `plugins.config['<literal>']` — core indexing a config slice by a plugin's NAME. A variable index
 *  (`plugins.config[name]`, the generic per-plugin accessor) is the platform doing its job and is not
 *  matched. */
const NAMED_SLICE = /plugins\.config\[\s*'([a-z0-9-]+)'\s*\]/g;

/** Core may only touch a named plugin's slice from a ONE-SHOT MIGRATION: those are permanent user data
 *  moves that must run even for a plugin that is disabled or uninstalled, so they cannot live in the
 *  plugin. Anything else — an accessor, a route, a service — is core deciding on a value it does not
 *  own; that read belongs to the owning plugin, which resolves its own slice. */
const ALLOWED_METHOD = /^migrate/;

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return tsFiles(p);
    return statSync(p).isFile() && e.name.endsWith('.ts') ? [p] : [];
  });
}

/** Name of the class method (or top-level function) a line sits in: the nearest declaration ABOVE it.
 *  Returns null when none can be resolved, which the test treats as a failure rather than a pass — an
 *  unattributable read is exactly the kind this guard exists to notice. */
function enclosingFunction(lines: string[], index: number): string | null {
  for (let i = index; i >= 0; i--) {
    const m = /^ {2}(?:private |protected |public |static |async )*([A-Za-z0-9_]+)\s*\(/.exec(lines[i]!)
      ?? /^(?:export )?(?:async )?function ([A-Za-z0-9_]+)\s*\(/.exec(lines[i]!);
    if (m) return m[1]!;
  }
  return null;
}

describe('core never reads a named plugin config slice', () => {
  it('only one-shot migrations index plugins.config by a plugin name', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(srcRoot)) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        NAMED_SLICE.lastIndex = 0;
        for (const m of line.matchAll(NAMED_SLICE)) {
          const fn = enclosingFunction(lines, i);
          if (fn !== null && ALLOWED_METHOD.test(fn)) continue;
          offenders.push(`${relative(repoRoot, file)}:${i + 1} plugins.config['${m[1]}'] in ${fn ?? '<unknown>'}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the migrations that ARE allowed still exist (the rule is live, not vacuous)', () => {
    const configStore = readFileSync(join(srcRoot, 'store', 'configStore.ts'), 'utf-8');
    expect([...configStore.matchAll(NAMED_SLICE)].length).toBeGreaterThan(0);
  });
});
