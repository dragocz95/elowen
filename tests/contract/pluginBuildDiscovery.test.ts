import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as { scripts: Record<string, string> };

/** Plugin folders that ship TypeScript SOURCES — the ones the build has to compile. A plugin shipping a
 *  prebuilt entry only (marketplace install) has no `src/**\/*.ts` and needs no root project. */
function typescriptPlugins(): string[] {
  const pluginsDir = join(repoRoot, 'plugins');
  return readdirSync(pluginsDir).filter((name) => {
    const src = join(pluginsDir, name, 'src');
    if (!existsSync(src) || !statSync(src).isDirectory()) return false;
    const walk = (dir: string): boolean => readdirSync(dir, { withFileTypes: true })
      .some((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts')));
    return walk(src);
  }).sort();
}

/** The build contract must not enumerate plugins. `build:ts` used to list
 *  `tsconfig.plugins.{agents,lsp,editor,work}.json` by hand, which fails in both directions and silently:
 *  a new TypeScript plugin is never compiled (its stale or missing `dist/index.js` just does not load),
 *  and a removed one breaks the whole build on a config that is no longer there. The script discovers the
 *  projects instead, and these tests hold that discovery to what is actually on disk. */
describe('the TypeScript build discovers plugin projects instead of naming them', () => {
  it('does not name a single plugin project in build:ts', () => {
    const named = [...pkg.scripts['build:ts']!.matchAll(/tsconfig\.plugins\.([a-z0-9-]+)\.json/g)].map((m) => m[1]!);
    expect(named).toEqual([]);
  });

  it('discovers exactly the root plugin projects that exist', () => {
    // Run the script's OWN discovery expression through the same shell npm would use, so this asserts the
    // mechanism that will actually build, not a re-implementation of it.
    const expansion = execFileSync('sh', ['-c', 'ls tsconfig.plugins.*.json 2>/dev/null'], { cwd: repoRoot, encoding: 'utf-8' })
      .split('\n').map((l) => l.trim()).filter(Boolean).sort();
    const onDisk = readdirSync(repoRoot).filter((f) => /^tsconfig\.plugins\.[a-z0-9-]+\.json$/.test(f)).sort();
    expect(expansion).toEqual(onDisk);
    expect(pkg.scripts['build:ts']).toContain('ls tsconfig.plugins.*.json');
  });

  it('gives every plugin shipping TypeScript sources a root project that emits into that plugin', () => {
    const missing: string[] = [];
    const misdirected: string[] = [];
    for (const name of typescriptPlugins()) {
      const config = join(repoRoot, `tsconfig.plugins.${name}.json`);
      if (!existsSync(config)) { missing.push(name); continue; }
      const parsed = JSON.parse(readFileSync(config, 'utf-8')) as { compilerOptions?: { outDir?: string } };
      if (parsed.compilerOptions?.outDir !== `plugins/${name}/dist`) misdirected.push(name);
    }
    expect({ missing, misdirected }).toEqual({ missing: [], misdirected: [] });
  });
});
