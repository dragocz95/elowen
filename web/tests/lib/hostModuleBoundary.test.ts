import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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

/** The feature modules that LEFT core for a plugin bundle. The work domain (its register, board,
 *  timeline and spend stats) is owned by the work plugin; the editor and the agents views by theirs. */
const DEPARTED = ['tasks', 'kanban', 'timeline', 'stats', 'editor', 'sessions', 'escalations'];
// Both spellings reach the same place: `../modules/tasks/x` from web/lib, and the sibling-relative
// `../tasks/x` a file inside web/modules uses. Missing the second one would let exactly the imports
// this guard exists for pass unnoticed.
const importsDeparted = (src: string) =>
  DEPARTED.filter((m) => new RegExp(`from '[^']*(?:modules|\\.\\.)/${m}/`).test(src));

/** The direction the host↔plugin contract fixes: the app hands a bundle a slice of itself through
 *  `web/lib/pluginUi.tsx`, and never reaches back the other way. Core growing an import into a plugin's
 *  sources would tie the app to a feature the operator is free to disable — and would not even build,
 *  since a bundle is compiled separately. Core growing the module BACK is the quieter failure: two
 *  implementations of the same page, one of them dead. */
describe('host ↔ plugin boundary', () => {
  it('no core web source imports a feature module that moved into a plugin', () => {
    const offenders = ['lib', 'components', 'modules', 'app']
      .map((d) => join(webRoot, d))
      .flatMap(sources)
      .map((file) => ({ file: relative(webRoot, file), modules: importsDeparted(readFileSync(file, 'utf8')) }))
      .filter((f) => f.modules.length > 0);
    expect(offenders).toEqual([]);
  });

  it('core web does not host a second copy of a plugin-owned feature module', () => {
    const resurrected = DEPARTED.filter((m) => existsSync(join(webRoot, 'modules', m)));
    expect(resurrected).toEqual([]);
  });

  it('no core web source imports a plugin bundle directly', () => {
    const offenders = ['lib', 'components', 'modules', 'app']
      .map((d) => join(webRoot, d))
      .flatMap(sources)
      .filter((file) => /from '[^']*plugins\/[^/']+\/web(-src)?/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(webRoot, file));
    expect(offenders).toEqual([]);
  });
});
