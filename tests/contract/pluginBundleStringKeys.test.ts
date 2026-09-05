import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { pluginBundleFiles } from './pluginBundleFiles.js';
import { tmpdir } from 'node:os';
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
 *  that disappears fails as a stale entry, and a new computed read fails until it is declared.
 *
 *  Empty today: the one entry was work's KanbanBoard (`s[col.labelKey]` over its COLUMNS table) and that
 *  plugin has moved to the plugin registry. An empty list is not an idle check — it is the assertion
 *  that NO bundle currently reads a key the scan cannot resolve, and the first one to do so fails here
 *  until it is declared. What that costs is the proof that the scan can still SEE a computed read, so
 *  the scanner is exercised against a fixture bundle at the bottom of this file. */
const COMPUTED_READS: { file: string; keys: string[] }[] = [];

interface Manifest { web?: { strings?: Record<string, string> } }

/** Every plugin declaring its own strings must contribute reads from local sources or shipped JS. */
function pluginsDeclaringStrings(): string[] {
  return readdirSync(PLUGINS).filter((name) => {
    try { return Object.keys((JSON.parse(readFileSync(join(PLUGINS, name, 'elowen-plugin.json'), 'utf-8')) as Manifest).web?.strings ?? {}).length > 0; } catch { return false; }
  }).sort();
}

function manifestStrings(plugin: string): Set<string> {
  const raw = readFileSync(join(PLUGINS, plugin, 'elowen-plugin.json'), 'utf-8');
  return new Set(Object.keys((JSON.parse(raw) as Manifest).web?.strings ?? {}));
}

/** Prose is not a call site: a key named in a doc comment has no consumer.
 *
 *  Both rules below err toward KEEPING code, deliberately. A false positive here is a loud
 *  missing-key failure that someone investigates; a read this function swallows is invisible and
 *  green forever. The naive form of this — `/\/\*[\s\S]*?\*\//g` — got that trade the wrong way
 *  round: any `/*` opened a comment, so a string holding a glob (`cat /some-dir/*`) opened one that
 *  closed at the next genuine doc block, taking every read in between with it. Measured on a real
 *  bundle: 56 lines, 14 reads, 10 keys, and an injected typo in that file reported nothing missing.
 *  So a block comment must OPEN its line (optionally after `{`, the JSX form), and a line comment is
 *  found by walking the line rather than by regex, so `//` inside a string stays code. */
function stripComments(source: string): string {
  const withoutBlocks = source.replace(/^[ \t]*\{?[ \t]*\/\*[\s\S]*?\*\/[ \t]*\}?[ \t]*$/gm, '');
  return withoutBlocks.split('\n').map(stripLineComment).join('\n');
}

/** Everything from an unquoted `//` to end of line. Quote state is tracked so a `//` inside a string
 *  literal — a URL, a path — is left alone; escapes are honoured so `'a\''` does not end early. */
function stripLineComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

/** The binding a file gave `usePluginStrings(<plugin>)`, e.g. `const s = hooks.usePluginStrings('work')`.
 *  A file may hold one per plugin; the binding name is what the reads below are matched against. */
const BINDING = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[\w$.]+\.)?usePluginStrings\(\s*['"]([^'"]+)['"]\s*\)/g;

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

function collect(pluginsDir: string = PLUGINS): { statik: Read[]; computed: { plugin: string; where: string }[]; shadowed: string[]; sites: number } {
  const statik: Read[] = [];
  const computed: { plugin: string; where: string }[] = [];
  const shadowed: string[] = [];
  let sites = 0;
  for (const plugin of readdirSync(pluginsDir)) {
    for (const file of pluginBundleFiles(pluginsDir, plugin)) {
      const source = stripComments(readFileSync(file, 'utf-8'));
      const bindings = new Map<string, string>(); // variable → plugin it reads
      for (const [, name, owner] of source.matchAll(BINDING)) bindings.set(name!, owner!);
      if (bindings.size === 0) continue;
      sites += bindings.size;
      const where = file.slice(pluginsDir.length + 1);
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
    // The scan really found the bundles: every plugin that declares strings of its own has a read site.
    // A plugin whose manifest carries copy nothing reads is dead weight the other direction, and would
    // hide a scan that has stopped seeing that bundle.
    const declaring = pluginsDeclaringStrings();
    expect(declaring.length).toBeGreaterThan(0);
    expect(declaring.filter((name) => !statik.some((read) => read.plugin === name))).toEqual([]);
    expect(sites).toBeGreaterThan(0);

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

/** Everything above is the SCAN's verdict on the bundles this package ships, and there is one of those
 *  left. Three of the four assertions read empty lists today — no undeclared computed read, no stale
 *  declaration, no shadowed binding — and an empty list means "clean" only for as long as the scanner
 *  still sees what it is looking at. A regex that stops matching would report exactly the same green.
 *  So the scanner is run over a bundle written here, holding one of each thing it must catch. */
describe('the scan itself still sees what it is looking for', () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  const scan = (files: Record<string, string>) => {
    dir = mkdtempSync(join(tmpdir(), 'plugin-strings-scan-'));
    for (const [path, source] of Object.entries(files)) {
      const full = join(dir, 'ledger', 'web-src', path);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, source);
    }
    return collect(dir);
  };

  it.each(["'", '"'])('resolves a %s-quoted static read, and ignores prose naming a key', (quote) => {
    const found = scan({
      'Panel.tsx': [
        `const s = hooks.usePluginStrings(${quote}ledger${quote});`,
        'export const Panel = () => <h1>{s.title}</h1>;',
        '// s.commentedOut is prose, not a call site',
      ].join('\n'),
    });
    expect(found.statik.map((r) => `${r.plugin}.${r.key}`)).toEqual(['ledger.title']);
    expect(found.sites).toBe(1);
  });

  it('keeps reading a file after a string that merely contains a comment opener', () => {
    // The regression this replaced: `/*` inside a string literal opened a block comment that closed
    // at the next real doc block, swallowing every read in between and reporting nothing missing.
    const found = scan({
      'Jobs.tsx': [
        "const s = hooks.usePluginStrings('ledger');",
        'export const Hint = () => <input placeholder="test -n x && cat /new-bookings/*" />;',
        'export const Link = () => <a href="https://example.com/docs">{s.docs}</a>;',
        '/** A genuine doc block, dozens of lines later. */',
        'export const Jobs = () => <h1>{s.title}</h1>;',
      ].join('\n'),
    });
    expect(found.statik.map((r) => r.key).sort()).toEqual(['docs', 'title']);
  });

  it('reports a computed read rather than passing over it', () => {
    const found = scan({
      'Board.tsx': [
        "const s = hooks.usePluginStrings('ledger');",
        'export const Board = ({ col }) => <span>{s[col.labelKey]}</span>;',
      ].join('\n'),
    });
    expect(found.computed.map((r) => `${r.plugin}: ${r.where}`)).toEqual(['ledger: ledger/web-src/Board.tsx']);
  });

  it('reports a binding name reused for something else instead of misreading its properties', () => {
    const found = scan({
      'Totals.tsx': [
        "const s = hooks.usePluginStrings('ledger');",
        'export const Totals = ({ rows }) => { const s = rows.summary; return <span>{s.amount}</span>; };',
      ].join('\n'),
    });
    expect(found.shadowed).toEqual(['ledger/web-src/Totals.tsx: "s"']);
    expect(found.statik).toEqual([]); // …and the misread properties never reach the key comparison
  });
});
