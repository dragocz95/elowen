import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

/** `off` is the STRICTER of the two quiet effects modes: it damps CSS exactly like `reduced` and also
 *  stops Motion's JS animations (`motionEnabled === false`). A damping rule bound to `reduced` alone
 *  therefore inverts the setting — picking "off" leaves the app visibly livelier than picking
 *  "reduced". That shipped: the dashboard mascot kept breathing, orbiting and emitting particles on
 *  the strictest setting, and so did the memory brain map, the skeletons and the ambient pulse.
 *
 *  The bug is invisible to a rendering test (jsdom applies no stylesheet) and to a reviewer reading one
 *  rule at a time, so it is pinned at the source: every `reduced` selector must name `off` beside it. */

const WEB = resolve(process.cwd());
const SCAN_DIRS = ['app', 'components', 'lib', 'modules'];
const EXTENSIONS = ['.css', '.ts', '.tsx'];

/** The one selector shape allowed to mention a quiet mode. Both modes named explicitly rather than
 *  `:not([data-effects='full'])` so a future mode opts into damping instead of inheriting it. */
const PAIRED = ":is([data-effects='reduced'], [data-effects='off'])";
const LONELY = "[data-effects='reduced']";

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      yield* walk(path);
    } else if (EXTENSIONS.some((ext) => entry.name.endsWith(ext)) && statSync(path).isFile()) {
      yield path;
    }
  }
}

describe('quiet effects modes', () => {
  it('never damps for "reduced" without damping for "off" too', () => {
    const offenders: string[] = [];
    let pairedSightings = 0;
    for (const file of SCAN_DIRS.flatMap((dir) => [...walk(join(WEB, dir))])) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes(LONELY)) continue;
      const paired = source.split(PAIRED);
      pairedSightings += paired.length - 1;
      // Whatever survives with the paired form removed is a selector naming `reduced` on its own.
      if (paired.join('').includes(LONELY)) offenders.push(relative(WEB, file));
    }
    expect(offenders).toEqual([]);
    // Guards the assertion above against passing because the damping rules were deleted outright.
    expect(pairedSightings).toBeGreaterThan(0);
  });
});
