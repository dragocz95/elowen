import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

/** The core stylesheets are shipped to every instance, plugins or none. A component class in them is
 *  invisible plumbing: nothing fails when its last consumer goes away, and nothing says out loud when
 *  its only consumer is a plugin bundle. Both rot silently, and both are only detectable by looking for
 *  the consumer — which is what this does, against the real source tree.
 *
 *  Two separate findings, deliberately kept apart:
 *
 *  DEAD — no consumer anywhere. That is dead CSS on every page load and is simply an error.
 *
 *  PLUGIN-ONLY — the only consumer is a plugin's browser bundle. That is core shipping the styling for
 *  a page it does not own, and it cannot be fixed by deleting: the platform has no per-plugin CSS
 *  delivery today (a bundle ships JS only, and the /p/<plugin> host loads no stylesheet of its own), so
 *  the rules have nowhere to move to yet. The list below is therefore a LEDGER, not an allowlist: it
 *  pins the debt at its current size so a new one cannot be added quietly, and it shrinks — with this
 *  test as the proof — once a bundle can carry its own stylesheet. */

const WEB = resolve(process.cwd());
const STYLES = join(WEB, 'app', 'styles');
const PLUGINS = resolve(WEB, '..', 'plugins');
const SOURCE_DIRS = ['app', 'components', 'lib', 'modules'];

/** Classes assembled at runtime (`spatial-mascot-fallback--${state}`), which no literal scan can see.
 *  Listed WITH the construction site so the exemption stays verifiable, and asserted to still exist. */
const DYNAMIC: { prefix: string; builtIn: string }[] = [
  { prefix: 'spatial-mascot-fallback--', builtIn: 'components/ui/SpatialMascot.tsx' },
];

/** Core CSS whose only consumer is a plugin bundle that IS in this repository, so the scan below can
 *  see the usage. See the note above: a ledger, not an allowlist.
 *
 *  Empty today — `subagent` is the last bundled `web-src/` and it styles itself. That is a real state,
 *  not a disabled check: the equality assertion below turns a NEW entry into a failure, so a bundled
 *  bundle that starts leaning on a core class has to record the debt here to go green. */
const PLUGIN_ONLY: string[] = [];

/** The same debt, for plugins that no longer live in this repository.
 *
 *  `editor`, `work` and `agents` moved to the plugin registry, so their `web-src/` is not on disk here
 *  and the scan below cannot see them using these. Without this list they read as DEAD and the obvious
 *  fix — deleting them — strips the styling off the installed plugin. That is not hypothetical: it is
 *  what a previous pass at this file did, and it would have cost the Tasks page its width and centring
 *  (`tasks-control-surface`), its row borders and its running-phase pulse the moment `work` was
 *  installed. Core references none of them, which is exactly why they look dead.
 *
 *  Each entry therefore carries WHERE the consumer is, in the registry checkout, so the claim is
 *  auditable instead of a bare string — the same reason DYNAMIC records its construction site. To
 *  re-verify an entry against a registry checkout, grep the class in BOTH the plugin's `web-src` and
 *  its built `web/index.js` — the built bundle is what the marketplace actually installs, and it is the
 *  one that decides whether an installed page is styled.
 *
 *  Unlike PLUGIN_ONLY the "still used" half cannot be verified from this repo, which makes it the
 *  weaker of the two records and worth keeping short. It is the same debt either way: core ships
 *  styling for a page it does not own, and it goes away when a bundle can carry its own stylesheet. */
const EXTERNAL_PLUGIN_ONLY: { class: string; plugin: string; usedIn: string }[] = [
  { class: 'editor-control-surface', plugin: 'editor', usedIn: 'web-src/EditorPage.tsx' },
  { class: 'markdown-preview', plugin: 'editor', usedIn: 'web-src/editor/MarkdownPreview.tsx' },
  { class: 'card-interactive', plugin: 'work', usedIn: 'web-src/timeline/ChangesOverTime.tsx' },
  { class: 'tasks-control-surface', plugin: 'work', usedIn: 'web-src/tasks/TasksView.tsx' },
  { class: 'task-day-section', plugin: 'work', usedIn: 'web-src/tasks/TasksView.tsx' },
  { class: 'task-register-row', plugin: 'work', usedIn: 'web-src/tasks/TaskCard.tsx' },
  { class: 'flow-active', plugin: 'work', usedIn: 'web-src/tasks/PhaseLogRow.tsx' },
  { class: 'escalation-register-row', plugin: 'agents', usedIn: 'web-src/escalations/EscalationsView.tsx' },
];
const externalOnly = new Set(EXTERNAL_PLUGIN_ONLY.map((entry) => entry.class));

function walk(dir: string, match: RegExp, out: string[] = []): string[] {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (!/^(node_modules|\.next|test-results)$/.test(entry.name)) walk(path, match, out); }
    else if (match.test(entry.name)) out.push(path);
  }
  return out;
}

const read = (paths: string[]): string => paths.map((p) => readFileSync(p, 'utf-8')).join('\n');

const coreSources = read(SOURCE_DIRS.flatMap((dir) => walk(join(WEB, dir), /\.tsx?$/)));
const pluginSources = read(
  readdirSync(PLUGINS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => walk(join(PLUGINS, entry.name, 'web-src'), /\.tsx?$/)),
);

/** Every class SELECTOR the core stylesheets define, by file. Only selectors that start a rule are
 *  read — a class inside a `:has()` or a descendant combinator names something declared elsewhere. */
function definedClasses(): Map<string, string> {
  const byClass = new Map<string, string>();
  for (const file of walk(STYLES, /\.css$/)) {
    const css = readFileSync(file, 'utf-8');
    for (const [, name] of css.matchAll(/^\s*\.([a-z][a-z0-9-]*)(?=[\s,{:.[])/gm)) {
      if (!byClass.has(name!)) byClass.set(name!, relative(WEB, file));
    }
  }
  return byClass;
}

const defined = definedClasses();
const isDynamic = (name: string): boolean => DYNAMIC.some((entry) => name.startsWith(entry.prefix));

describe('core stylesheet ownership', () => {
  it('found the stylesheets and both source trees', () => {
    expect(defined.size).toBeGreaterThan(50);
    expect(coreSources.length).toBeGreaterThan(10_000);
    expect(pluginSources.length).toBeGreaterThan(10_000);
  });

  it('declares every runtime-assembled class, and each construction site still exists', () => {
    for (const entry of DYNAMIC) {
      expect(coreSources, `${entry.builtIn} no longer builds ${entry.prefix}`).toContain(`${entry.prefix}$`);
      expect([...defined.keys()].some((name) => name.startsWith(entry.prefix)),
        `no class starts with ${entry.prefix} any more`).toBe(true);
    }
  });

  it('defines no class that nothing uses', () => {
    const dead = [...defined].filter(([name]) =>
      !isDynamic(name) && !coreSources.includes(name) && !pluginSources.includes(name)
      && !externalOnly.has(name));
    expect(dead.map(([name, file]) => `${file}: .${name}`)).toEqual([]);
  });

  it('still defines the classes an out-of-repo plugin depends on', () => {
    // The other direction: an entry here must name a rule that actually exists, or the record is a
    // comforting fiction and the installed plugin is already unstyled.
    const missing = EXTERNAL_PLUGIN_ONLY.filter((entry) => !defined.has(entry.class)).map((e) => e.class);
    expect(missing, `recorded for an external plugin but no longer in the stylesheets: ${missing.join(', ')}`)
      .toEqual([]);
  });

  it('records nothing as external-only that this repo turned out to use', () => {
    // The half of EXTERNAL_PLUGIN_ONLY that IS checkable here. An entry is a claim of two things: the
    // rule exists (above), and its only consumer is out of reach of this scan. The moment core or a
    // bundled plugin starts using one, the second claim is false — the entry is now buying a DEAD
    // exemption it no longer needs, and it hides the class from the ledger that should be tracking it.
    // Without this the list can only ever grow and no failure ever asks for an entry back.
    const stale = EXTERNAL_PLUGIN_ONLY
      .filter((entry) => coreSources.includes(entry.class) || pluginSources.includes(entry.class))
      .map((entry) => entry.class);
    expect(stale, `recorded as external-plugin-only but used inside this repo: ${stale.join(', ')}`)
      .toEqual([]);
  });

  it('names a real consumer for every external-only entry', () => {
    // The registry checkout is not on disk in CI, so the usage itself cannot be re-derived here. What
    // CAN be pinned is that the record stays auditable: a bare class name with no plugin and no file is
    // an unfalsifiable exemption, and this list is the one place where an unfalsifiable exemption
    // silently keeps dead CSS alive forever.
    for (const entry of EXTERNAL_PLUGIN_ONLY) {
      expect(entry.plugin, `${entry.class} records no owning plugin`).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(entry.usedIn, `${entry.class} records no consumer file`).toMatch(/^web-src\/.+\.tsx?$/);
    }
  });

  it('ships exactly the recorded set of classes only a plugin bundle uses', () => {
    const pluginOnly = [...defined]
      .filter(([name]) => !isDynamic(name) && !coreSources.includes(name) && pluginSources.includes(name))
      .map(([name]) => name)
      .sort();
    // Equality both ways on purpose: a NEW plugin-only class fails as debt that was added quietly, and
    // a recorded one that is gone fails as a stale entry — so paying the debt down updates this list.
    expect(pluginOnly).toEqual([...PLUGIN_ONLY].sort());
  });
});
