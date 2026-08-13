import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Copy that ONLY a plugin's own views render lives in that plugin's manifest `web.strings`, and the
 *  bundle reads it through the runtime's `usePluginStrings(<plugin>)`. That record is untyped by
 *  construction — the host cannot know a plugin's keys, and a bundle may not import the web app — so a
 *  key the manifest does not carry renders as `undefined`: an empty label, or a crash where the view
 *  calls `.replace` on it. Nothing else catches that.
 *
 *  This is the same class of error `pluginBundleI18nKeys` catches on the HOST catalog, checked on the
 *  side the copy moved to. Both are needed: a bundle legitimately reads from both sources — the host
 *  dictionary for copy shared with core surfaces, its own manifest for copy nothing else renders.
 *
 *  `scripts/check-languages.mjs` covers the other half (every manifest string is translated in every
 *  locale, and no translation is an orphan), so between them a key is guaranteed to exist in English
 *  and in every locale the instance ships. */

const PLUGINS = join(process.cwd(), 'plugins');

/** Computed reads (`s[expr]`) cannot be resolved statically. Rather than silently falling outside the
 *  check, each one is listed here with the keys it can produce — so the read is still verified, a site
 *  that disappears fails as a stale entry, and a new computed read fails until it is declared. */
const COMPUTED_READS: { file: string; keys: string[] }[] = [
  {
    // KanbanBoard: `s[col.labelKey]` over the fixed COLUMNS table.
    file: 'work/web-src/kanban/KanbanBoard.tsx',
    keys: ['kbColumnOpen', 'kbColumnInProgress', 'kbColumnBlocked', 'kbColumnClosed', 'kbColumnCancelled'],
  },
];

interface Manifest { web?: { strings?: Record<string, string> } }

function bundleFiles(plugin: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry)) out.push(path);
    }
  };
  try { walk(join(PLUGINS, plugin, 'web-src')); } catch { /* plugin ships no bundle */ }
  return out;
}

function manifestStrings(plugin: string): Set<string> {
  const raw = readFileSync(join(PLUGINS, plugin, 'elowen-plugin.json'), 'utf-8');
  return new Set(Object.keys((JSON.parse(raw) as Manifest).web?.strings ?? {}));
}

/** Prose is not a call site: a key named in a doc comment has no consumer. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** The binding a file gave `usePluginStrings(<plugin>)`, e.g. `const s = hooks.usePluginStrings('work')`.
 *  A file may hold one per plugin; the binding name is what the reads below are matched against. */
const BINDING = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[\w$.]+\.)?usePluginStrings\(\s*'([^']+)'\s*\)/g;

interface Read { plugin: string; key: string; where: string }

/** A declaration of the binding's name that is NOT the strings read itself. The scan matches
 *  `<binding>.<key>` textually, so a local of the same name (a reduce accumulator called `s`, say)
 *  would be read as a string lookup and reported as a missing key that is not one. Rather than guess
 *  a scope, that is failed outright with the fix: rename the local. Several COMPONENTS in one file
 *  each declaring the same strings binding is not shadowing — it is the same binding, per component. */
const foreignDeclaration = (name: string): RegExp =>
  // The whitespace sits INSIDE the lookahead on purpose: with `=\s*(?!…)` in front of it, `\s*` simply
  // backtracks to zero and the negative lookahead passes on every declaration, including the intended ones.
  new RegExp(`(?:const|let|var)\\s+${name}\\s*=(?!\\s*(?:[\\w$.]+\\.)?usePluginStrings\\()`, 'g');

function collect(): { statik: Read[]; computed: { plugin: string; where: string }[]; shadowed: string[]; sites: number } {
  const statik: Read[] = [];
  const computed: { plugin: string; where: string }[] = [];
  const shadowed: string[] = [];
  let sites = 0;
  for (const plugin of readdirSync(PLUGINS)) {
    for (const file of bundleFiles(plugin)) {
      const source = stripComments(readFileSync(file, 'utf-8'));
      const bindings = new Map<string, string>(); // variable → plugin it reads
      for (const [, name, owner] of source.matchAll(BINDING)) bindings.set(name!, owner!);
      if (bindings.size === 0) continue;
      sites += bindings.size;
      const where = file.slice(PLUGINS.length + 1);
      for (const [name, owner] of bindings) {
        if (foreignDeclaration(name).test(source)) { shadowed.push(`${where}: "${name}"`); continue; }
        for (const [, key] of source.matchAll(new RegExp(`\\b${name}\\.([A-Za-z_$][\\w$]*)`, 'g'))) {
          statik.push({ plugin: owner, key: key!, where });
        }
        if (new RegExp(`\\b${name}\\[`).test(source)) computed.push({ plugin: owner, where });
      }
    }
  }
  return { statik, computed, shadowed, sites };
}

describe('plugin web bundles against their own manifest strings', () => {
  const { statik, computed, shadowed, sites } = collect();

  // A file that reuses the binding's name for something else is skipped by the scan above, which would
  // quietly take its reads outside the check — so it fails here instead, naming the file to rename in.
  it('do not shadow the strings binding', () => {
    expect(shadowed).toEqual([]);
  });

  it('read only keys their manifest declares', () => {
    expect(sites).toBeGreaterThan(0); // the scan really found the bundles

    const byPlugin = new Map<string, Set<string>>();
    const missing: string[] = [];
    for (const { plugin, key, where } of statik) {
      if (!byPlugin.has(plugin)) byPlugin.set(plugin, manifestStrings(plugin));
      if (!byPlugin.get(plugin)!.has(key)) missing.push(`${where}: ${plugin}.${key}`);
    }
    expect(missing).toEqual([]);
  });

  it('declare every computed read, and every declared one still exists', () => {
    // A computed read this scan cannot resolve must be visible, never skipped — the declaration is
    // what keeps it inside the check.
    const declared = new Set(COMPUTED_READS.map((entry) => entry.file));
    expect(computed.filter((read) => !declared.has(read.where)).map((read) => read.where)).toEqual([]);

    const found = new Set(computed.map((read) => read.where));
    expect(COMPUTED_READS.filter((entry) => !found.has(entry.file)).map((entry) => entry.file)).toEqual([]);

    const missing: string[] = [];
    for (const entry of COMPUTED_READS) {
      const plugin = entry.file.split('/')[0]!;
      const strings = manifestStrings(plugin);
      for (const key of entry.keys) if (!strings.has(key)) missing.push(`${entry.file}: ${plugin}.${key}`);
    }
    expect(missing).toEqual([]);
  });
});
