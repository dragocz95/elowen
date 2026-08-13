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
    expect(files.length).toBeGreaterThan(10); // the scan really found the bundles

    const missing: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf-8');
      for (const [, ns, key, sub] of src.matchAll(REF)) {
        if (!NAMESPACES.has(ns!)) continue;
        const group = (en as Record<string, unknown>)[ns!] as Record<string, unknown>;
        const rel = file.slice(BUNDLES.length + 1);
        if (!(key! in group)) { missing.push(`${rel}: t.${ns}.${key}`); continue; }
        const leaf = group[key!];
        if (sub && leaf !== null && typeof leaf === 'object' && !(sub in (leaf as Record<string, unknown>))) {
          missing.push(`${rel}: t.${ns}.${key}.${sub}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
