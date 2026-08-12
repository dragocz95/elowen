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

  /** `web/lib` is the layer BELOW the feature modules, and the plugin contract is served from it. Where
   *  it reaches UP into a module, that module owns something the contract re-serves — the settings deck's
   *  own primitives. A pure helper reached that way is the quiet failure: the work extraction left
   *  `statusTone` in `modules/dashboard` with the contract as its only consumer, so the next module move
   *  would have taken a helper four plugin bundles render with it. */
  it('web/lib reaches into a feature module only for the components that module owns', () => {
    const allowed = [
      'modules/settings/providers',
      'modules/settings/SettingsSurface',
      'modules/settings/MarkdownAssetEditor',
    ];
    const offenders = sources(join(webRoot, 'lib')).flatMap((file) => {
      const src = readFileSync(file, 'utf8');
      return [...src.matchAll(/from '[^']*\/(modules\/[^']+)'/g)]
        .map((m) => m[1]!)
        .filter((mod) => !allowed.includes(mod))
        .map((mod) => `${relative(webRoot, file)} → ${mod}`);
    });
    expect(offenders).toEqual([]);
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
