import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const webRoot = join(import.meta.dirname, '..', '..');

/** Every source file under `dir`, recursively. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

/** The feature modules that are on their way OUT of core and into a plugin bundle. */
const DEPARTING = ['tasks', 'kanban', 'timeline', 'stats'];
// Both spellings reach the same place: `../modules/tasks/x` from web/lib, and the sibling-relative
// `../tasks/x` a file inside web/modules uses. Missing the second one would let exactly the imports
// this guard exists for pass unnoticed.
const importsDeparting = (src: string) =>
  DEPARTING.filter((m) => new RegExp(`from '[^']*(?:modules|\\.\\.)/${m}/`).test(src));

// The host runtime hands plugin bundles a slice of the app (`web/lib/pluginUi.tsx` → utils/hooks/
// components). If any of it is imported OUT of a feature module, that module cannot leave core without
// breaking the contract for every OTHER plugin too — the agents bundle reads `utils.taskTypeMeta`, and
// it would have gone dark the moment the task views moved. So the direction is fixed: shared things
// live in web/lib and feature modules consume them, never the reverse.
describe('host ↔ departing-module boundary', () => {
  it('nothing in web/lib imports from a module that is leaving core', () => {
    const offenders = sources(join(webRoot, 'lib'))
      .map((file) => ({ file: relative(webRoot, file), modules: importsDeparting(readFileSync(file, 'utf8')) }))
      .filter((f) => f.modules.length > 0);
    expect(offenders).toEqual([]);
  });

  // Same rule for the core surfaces that STAY: the dashboard and the advisor render task/usage/activity
  // shapes, and each one that reaches into a departing module is one more thing to untangle later — or,
  // worse, a page that silently loses a helper the day the module moves.
  it('the core surfaces that stay do not import from a module that is leaving', () => {
    const staying = ['components', 'modules/dashboard', 'modules/advisor', 'modules/settings', 'modules/sessions']
      .map((d) => join(webRoot, d))
      .filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } });
    const offenders = staying.flatMap(sources)
      .map((file) => ({ file: relative(webRoot, file), modules: importsDeparting(readFileSync(file, 'utf8')) }))
      .filter((f) => f.modules.length > 0);
    expect(offenders).toEqual([]);
  });
});
