import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as { scripts: Record<string, string> };

/** The exact expression `build:ts` uses to find plugin compile units, substitution and all. Asserted to
 *  be IN the script below, so running it here runs the mechanism that will actually build rather than a
 *  re-implementation of it.
 *
 *  The wrapping matters as much as the glob: with no match `ls` writes to stderr and exits 2, so the
 *  redirect and the command substitution are what let a repo with no TypeScript plugin build at all —
 *  which is this repo today. Measured through the substitution for that reason; run bare, it throws. */
const DISCOVERY = '$(ls tsconfig.plugins.*.json 2>/dev/null)';

/** Plugin folders that ship TypeScript SOURCES — the ones the build has to compile. A plugin shipping a
 *  prebuilt entry only (marketplace install) or a hand-written .mjs has no `src/**\/*.ts` and needs no
 *  root project. Parameterised by root so the detector itself can be exercised against a fixture tree. */
function typescriptPlugins(root: string): string[] {
  const pluginsDir = join(root, 'plugins');
  return readdirSync(pluginsDir).filter((name) => {
    const src = join(pluginsDir, name, 'src');
    if (!existsSync(src) || !statSync(src).isDirectory()) return false;
    const walk = (dir: string): boolean => readdirSync(dir, { withFileTypes: true })
      .some((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts')));
    return walk(src);
  }).sort();
}

/** Run the build's own discovery expression, in the same shell npm would use, against any directory. */
function discover(cwd: string): string[] {
  return execFileSync('sh', ['-c', `echo ${DISCOVERY}`], { cwd, encoding: 'utf-8' })
    .split(/\s+/).map((l) => l.trim()).filter(Boolean).sort();
}

let scratch: string[] = [];
afterEach(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); scratch = []; });

/** A throwaway repo-shaped tree: root tsconfigs plus a plugins/ dir, so the discovery expression and the
 *  source detector can be measured against compile units that exist. This package currently ships NONE —
 *  agents and work were the last two TypeScript plugins and they moved to the plugin registry — and an
 *  empty-versus-empty comparison proves nothing at all, so what is under test here is the MECHANISM: the
 *  glob that will pick up the next one to land, and the detector that decides one is owed a root project. */
function fixtureTree(spec: { rootFiles: string[]; plugins: Record<string, string[]> }): string {
  const dir = mkdtempSync(join(tmpdir(), 'elowen-build-discovery-'));
  scratch.push(dir);
  for (const file of spec.rootFiles) writeFileSync(join(dir, file), '{}');
  for (const [plugin, files] of Object.entries(spec.plugins)) {
    for (const file of files) {
      const full = join(dir, 'plugins', plugin, file);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, '');
    }
    mkdirSync(join(dir, 'plugins', plugin), { recursive: true });
  }
  mkdirSync(join(dir, 'plugins'), { recursive: true });
  return dir;
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
    expect(pkg.scripts['build:ts']).toContain(DISCOVERY);
  });

  it('discovers exactly the root plugin projects that exist', () => {
    const onDisk = readdirSync(repoRoot).filter((f) => /^tsconfig\.plugins\.[a-z0-9-]+\.json$/.test(f)).sort();
    expect(discover(repoRoot)).toEqual(onDisk);
    // Today that set is empty on both sides, which is why the two tests below carry the weight: they
    // measure the glob against compile units that exist, and the empty case against the build command.
    expect(onDisk).toEqual([]);
  });

  it('picks up a plugin compile unit the day one lands, and nothing else', () => {
    const dir = fixtureTree({
      rootFiles: [
        'tsconfig.plugins.ledger.json', 'tsconfig.plugins.audit.json',
        'tsconfig.json', 'tsconfig.web.json', // root projects the plugin glob must not swallow
        'tsconfig.plugins.json', 'tsconfig.plugins.ledger.json.bak', // near-misses on either side
      ],
      plugins: {},
    });
    expect(discover(dir)).toEqual(['tsconfig.plugins.audit.json', 'tsconfig.plugins.ledger.json']);
  });

  it('collapses to a plain single-project build when no plugin ships TypeScript', () => {
    // The zero-match case is this package's CURRENT state, and it is the one an unguarded glob breaks:
    // with no `2>/dev/null` the build prints an ls error, and an unexpanded literal would reach tsc as a
    // project path that does not exist. Expanding the real script is the only way to see which happened.
    const expanded = execFileSync('sh', ['-c', `echo ${pkg.scripts['build:ts']!}`], { cwd: repoRoot, encoding: 'utf-8' }).trim();
    expect(expanded).toBe('tsc -b tsconfig.json');
  });

  it('gives every plugin shipping TypeScript sources a root project that emits into that plugin', () => {
    const missing: string[] = [];
    const misdirected: string[] = [];
    for (const name of typescriptPlugins(repoRoot)) {
      const config = join(repoRoot, `tsconfig.plugins.${name}.json`);
      if (!existsSync(config)) { missing.push(name); continue; }
      const parsed = JSON.parse(readFileSync(config, 'utf-8')) as { compilerOptions?: { outDir?: string } };
      if (parsed.compilerOptions?.outDir !== `plugins/${name}/dist`) misdirected.push(name);
    }
    expect({ missing, misdirected }).toEqual({ missing: [], misdirected: [] });
  });

  it('owes a root project to a plugin with TypeScript sources, and to no other', () => {
    // The loop above has nothing to iterate in this package, so the detector behind it is measured here:
    // a plugin is owed a compile unit because of what it SHIPS, not because of what it is called.
    const dir = fixtureTree({
      rootFiles: [],
      plugins: {
        ledger: ['src/index.ts'], // plain TypeScript source
        audit: ['src/deep/nested/rule.ts'], // found however deep it sits
        statusline: ['index.mjs'], // hand-written JavaScript plugin
        vault: ['dist/index.js', 'elowen-plugin.json'], // prebuilt entry, no sources
        journal: ['src/README.md'], // a src/ dir with nothing to compile
      },
    });
    expect(typescriptPlugins(dir)).toEqual(['audit', 'ledger']);
  });
});
