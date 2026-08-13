import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// A plugin bundle paints inside the host's skin. Every colour it uses has to come from the design
// tokens in web/app/styles/tokens.css, because those are the single dial a repaint turns: a literal
// #ffd09a in a chart survives a rebrand and leaves one orange streak in an otherwise recoloured app.
// This was not hypothetical — the stats chart carried three of them, and the editor a fourth that was
// simply --color-document written out by hand.
//
// The check is deliberately mechanical rather than tasteful: it looks for hex literals in bundle
// sources, so the day a plugin needs a shade that no token carries, the answer is to add the token
// (which a theme can then move) instead of hard-coding the shade where no theme can reach it.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Every `plugins/<name>/web-src/**` source, minus tests — a new plugin is covered the day it lands. */
function bundleSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      out.push(full);
    }
  };
  const pluginsDir = resolve(repoRoot, 'plugins');
  for (const name of readdirSync(pluginsDir)) {
    const webSrc = resolve(pluginsDir, name, 'web-src');
    try { if (!statSync(webSrc).isDirectory()) continue; } catch { continue; }
    walk(webSrc);
  }
  return out.sort();
}

const HEX = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g;

describe('plugin bundles paint from the host tokens, not from literals', () => {
  it('finds the bundle sources at all', () => {
    const files = bundleSources();
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.includes('/work/web-src/'))).toBe(true);
  });

  it('has no hard-coded colour in any plugin bundle source', () => {
    const offenders: string[] = [];
    for (const file of bundleSources()) {
      const text = readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        for (const hit of line.match(HEX) ?? []) {
          offenders.push(`${relative(repoRoot, file)}:${i + 1} ${hit}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
