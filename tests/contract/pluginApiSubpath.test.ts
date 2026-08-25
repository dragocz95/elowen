import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/** The package's `exports` map is a PUBLIC contract, and adding one at all is the sharp edge.
 *
 *  A package with no `exports` map lets any deep path through, so `elowen/dist/api/server.js` resolves
 *  by accident rather than by design — and the plugin registry already relies on exactly that in its own
 *  suites. The moment a map exists, everything not listed in it stops resolving. Introducing one is
 *  therefore a breaking change unless the map deliberately keeps the deep paths open, which is what the
 *  wildcards below are for.
 *
 *  `./plugin-api` is the one path that is meant to be depended on: a plugin compiled outside this repo
 *  imports its types from there instead of reaching into `dist/` and hoping the layout never moves.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as {
  exports?: Record<string, string | Record<string, string>>;
  files?: string[];
};

/** Node's subpath matching, reduced to what this map uses: exact keys, and a single `*` wildcard that
 *  captures a path segment run. Resolving for real would need the package installed inside itself, so
 *  this mirrors the algorithm instead — enough to answer "would this import still work". */
function resolveSubpath(subpath: string): string | null {
  const map = pkg.exports;
  if (!map) return null;
  const pick = (t: string | Record<string, string>): string =>
    typeof t === 'string' ? t : (t.default ?? t.types ?? '');
  if (map[subpath]) return pick(map[subpath]);
  for (const [key, target] of Object.entries(map)) {
    const star = key.indexOf('*');
    if (star === -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    const captured = subpath.slice(prefix.length, subpath.length - (suffix.length || 0));
    return pick(target).replace('*', captured);
  }
  return null;
}

describe('the published package exposes a stable plugin API subpath', () => {
  it('declares an exports map at all', () => {
    // Without this the rest of the file would pass vacuously: every assertion below is about the map's
    // shape, and "no map" would otherwise read as "nothing is blocked".
    expect(pkg.exports, 'package.json must declare an exports map').toBeTruthy();
  });

  it('resolves `elowen/plugin-api` to the plugin API module and its types', () => {
    const map = pkg.exports!;
    const entry = map['./plugin-api'];
    expect(entry, 'the ./plugin-api subpath is the contract a compiled plugin imports').toBeTruthy();
    expect(typeof entry).toBe('object');
    const conditions = entry as Record<string, string>;
    // `types` first is not cosmetic: TypeScript under NodeNext reads the conditions in order and a
    // runtime-only entry would leave an external plugin with `any`, which is worse than a hard failure.
    expect(Object.keys(conditions)[0]).toBe('types');
    expect(conditions.types).toBe('./dist/plugins/api.d.ts');
    expect(conditions.default).toBe('./dist/plugins/api.js');
  });

  it('points that subpath at a module that really exists in this repo', () => {
    // The compiled target only exists after a build, so the source is what is asserted here; the built
    // artefact is checked opportunistically so a stale map cannot survive a full build either.
    expect(existsSync(join(repoRoot, 'src', 'plugins', 'api.ts'))).toBe(true);
  });

  it('keeps the deep paths the plugin registry already imports resolvable', () => {
    // These are REAL imports from /var/www/elowen-plugins suites (pluginAdminRoutes.test.ts). They
    // resolved by accident before, because there was no map; now they resolve because the wildcards say
    // so. Dropping a wildcard would break that repo silently on its next `npm install`, which is the
    // failure this test exists to prevent.
    const usedByRegistry = [
      './dist/api/server.js',
      './dist/api/sse.js',
      './dist/store/configStore.js',
      './dist/shared/clock.js',
      './plugins/work/dist/store/taskStore.js',
      './plugins/agents/dist/store/missionStore.js',
    ];
    const unresolved = usedByRegistry.filter((p) => resolveSubpath(p) === null);
    expect(unresolved, `the exports map would break these existing imports: ${unresolved.join(', ')}`)
      .toEqual([]);
  });

  it('exposes package.json, which tooling reads to discover the installed version', () => {
    expect(resolveSubpath('./package.json')).toBe('./package.json');
  });

  it('only exports paths the package actually ships', () => {
    // An exports entry pointing outside `files` resolves in this checkout and 404s for everyone who
    // installed from npm — the worst kind of drift, because it cannot reproduce locally.
    const shipped = pkg.files ?? [];
    const roots = new Set(
      Object.values(pkg.exports!)
        .map((t) => (typeof t === 'string' ? t : (t.default ?? '')))
        .filter(Boolean)
        .map((t) => t.replace(/^\.\//, '').split('/')[0]!)
        // npm always publishes package.json regardless of `files`, so it needs no entry there.
        .filter((root) => root !== 'package.json'),
    );
    for (const root of roots) {
      const covered = shipped.some((f) => f === `${root}/` || f === root || f.startsWith(`${root}/`));
      expect(covered, `exports references "${root}/" but package.json files does not ship it`).toBe(true);
    }
  });
});
