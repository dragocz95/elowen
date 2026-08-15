import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { en } from '../../web/lib/i18n/dictionaries/en.js';

/** Plugin web bundles render their copy out of the HOST's translation catalog (they reach it through the
 *  runtime's `useTranslation`), because that copy is shared with core surfaces and duplicating hundreds
 *  of keys per bundle could not be kept in sync. Inside the host app that arrangement is type-checked:
 *  `LocaleDict` there is `Widen<typeof en>`, so a key that does not exist does not compile.
 *
 *  A bundle cannot import that type — it is a separate compile unit, and the layering rule
 *  (.dependency-cruiser.cjs → plugin-bundle-not-to-web-app) forbids reaching into the web app — so the
 *  bundles declare a structural `LocaleDict` of their own and lose the key checking. This test restores
 *  the guarantee mechanically for EVERY bundle: a key the host dictionary does not carry renders as
 *  `undefined` (or crashes on a call) in the browser, which no gate would otherwise catch.
 *
 *  Only `t.<namespace>.<key>` where `<namespace>` is a real top-level entry of the catalog is checked:
 *  bundles also name loop variables `t` (a task), and those never spell a real namespace. Computed
 *  access (`t.nav[world.id]`) and aliases (`const e = t.dashboard.ev`) are outside what a static scan
 *  can see — an under-approximation with no false positives, not a claim of totality. */

const BUNDLES = join(process.cwd(), 'plugins');
const NAMESPACES = new Set(Object.keys(en));
const REF = /\bt\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?/g;

/** Plugins whose manifest declares a browser bundle — the scan has to reach every one of them. Derived
 *  from the manifests rather than counted: `subagent` is the only bundled plugin with a web-src/ left
 *  (agents, work and editor took theirs to the plugin registry), so a file-count floor would be a magic
 *  number, while this fails the day a DECLARED bundle stops being scanned. */
function pluginsDeclaringABundle(): string[] {
  return readdirSync(BUNDLES).filter((name) => {
    try {
      const manifest = JSON.parse(readFileSync(join(BUNDLES, name, 'elowen-plugin.json'), 'utf-8')) as { web?: { entry?: string } };
      return typeof manifest.web?.entry === 'string';
    } catch { return false; }
  }).sort();
}

function bundleFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(entry)) out.push(p);
    }
  };
  for (const plugin of readdirSync(BUNDLES)) {
    const webSrc = join(BUNDLES, plugin, 'web-src');
    try { if (statSync(webSrc).isDirectory()) walk(webSrc); } catch { /* plugin ships no bundle */ }
  }
  return out;
}

describe('plugin web bundles against the host translation catalog', () => {
  it('reference only keys the catalog actually carries', () => {
    const files = bundleFiles();
    // The scan really found the bundles: every plugin that declares one contributes a source.
    const declaring = pluginsDeclaringABundle();
    expect(declaring.length).toBeGreaterThan(0);
    expect(declaring.filter((name) => !files.some((f) => f.startsWith(join(BUNDLES, name, 'web-src') + '/')))).toEqual([]);

    const missing: string[] = [];
    let checked = 0;
    for (const file of files) {
      const src = readFileSync(file, 'utf-8');
      for (const [, ns, key, sub] of src.matchAll(REF)) {
        if (!NAMESPACES.has(ns!)) continue;
        checked++;
        const group = (en as Record<string, unknown>)[ns!] as Record<string, unknown>;
        const rel = file.slice(BUNDLES.length + 1);
        if (!(key! in group)) { missing.push(`${rel}: t.${ns}.${key}`); continue; }
        const leaf = group[key!];
        if (sub && leaf !== null && typeof leaf === 'object' && !(sub in (leaf as Record<string, unknown>))) {
          missing.push(`${rel}: t.${ns}.${key}.${sub}`);
        }
      }
    }
    // Finding the FILES is not the same as finding the references: with a single bundle left, the whole
    // check would go quiet if its two `t.<namespace>.<key>` reads were rewritten or the pattern drifted,
    // and `missing` would stay empty for the wrong reason. So at least one resolved reference must have
    // been compared — the day none is, this says so instead of reporting green over an idle scan.
    expect(checked).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});
