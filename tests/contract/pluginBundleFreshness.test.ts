import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** A bundled plugin's browser UI is GENERATED: `npm run build:plugins-web` writes `web/index.js` (and
 *  `web/index.css`) from `plugins/<name>/web-src/`, and `npm run build` copies it into `dist/`, which is
 *  where the daemon loads and content-hashes it for the running instance. The generated file is
 *  gitignored (each plugin's `web/` directory is listed in `.gitignore` by name), so a merge that changes
 *  `web-src/` leaves the OLD file in place.
 *
 *  That is not hypothetical: the rewritten sandbox drawer kept serving a bundle whose sources had deleted
 *  the disk control and added a lifecycle surface, and every bundle contract test stayed green because
 *  each of them reads `web-src/` when it exists (`pluginBundleFiles`). Nothing compared the two, so
 *  nothing said the running UI was the previous one.
 *
 *  The comparison is by write time, which catches any source change — a string, a control, a rule — rather
 *  than only the ones some other scan happens to read. A checkout that never built has no bundle and
 *  nothing to compare; one that built must have built after the sources it built from. */
const PLUGINS = join(process.cwd(), 'plugins');
const GENERATED = ['index.js', 'index.css'];

/** The newest write under a directory, ignoring test files: they are not bundle inputs. */
function newestWrite(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestWrite(path));
    else if (!/\.test\.[tj]sx?$/.test(entry.name)) newest = Math.max(newest, statSync(path).mtimeMs);
  }
  return newest;
}

const pluginsWithSources = readdirSync(PLUGINS).filter((name) => existsSync(join(PLUGINS, name, 'web-src')));

describe('a generated plugin bundle against the sources it was built from', () => {
  const stale = pluginsWithSources.flatMap((name) => {
    const built = newestWrite(join(PLUGINS, name, 'web-src'));
    return GENERATED
      .map((file) => join(PLUGINS, name, 'web', file))
      .filter((path) => existsSync(path) && statSync(path).mtimeMs < built)
      .map((path) => path.slice(PLUGINS.length + 1));
  });

  it('is not older than its own web-src', () => {
    expect(stale, 'A generated plugin bundle predates the sources it is built from, so the daemon is '
      + 'serving the previous UI out of dist/. Rebuild it with `npm run build:plugins-web`, then reload '
      + 'the page (a daemon restart is only needed when the bundle moved into a fresh dist/).').toEqual([]);
  });

  it('scanned a bundle that exists rather than an empty list', () => {
    // The check above is only meaningful while the plugins it skips are the ones that have not built.
    // A scan that found no sources would pass forever, so the inputs are asserted here.
    expect(pluginsWithSources.length).toBeGreaterThan(0);
    expect(pluginsWithSources.some((name) => existsSync(join(PLUGINS, name, 'web-src', 'index.tsx')))).toBe(true);
  });
});
