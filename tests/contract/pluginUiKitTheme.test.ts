import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// `packages/plugin-ui-kit/theme.css` is a MIRROR of the `@theme` blocks in `web/app/styles/tokens.css`.
// A plugin's stylesheet is compiled against the mirror (the kit is published standalone and cannot reach
// into the app), and every utility it emits reads `var(--token, <fallback from the mirror>)`. So the day
// the host renames or drops a token and the mirror keeps it, the plugin silently paints the STALE
// fallback instead of the host's live value — an unstyled-looking regression with nothing to grep for.
// This test is the only thing that makes that drift loud.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Every `@theme { … }` block of a stylesheet, brace-balanced, in source order. */
function themeBlocks(css: string): string[] {
  const out: string[] = [];
  let i = 0;
  while ((i = css.indexOf('@theme', i)) !== -1) {
    const open = css.indexOf('{', i);
    if (open === -1) break;
    let depth = 0;
    let j = open;
    for (; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}' && --depth === 0) { j++; break; }
    }
    out.push(css.slice(i, j));
    i = j;
  }
  return out;
}

/** `--token: value` declarations of a block, so the comparison is about the CONTRACT (which tokens
 *  exist and what they resolve to) and not about comment wording or indentation. */
function tokens(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const block of themeBlocks(css)) {
    for (const [, key, value] of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)[;}]/gi)) {
      out[key] = value.trim();
    }
  }
  return out;
}

const hostCss = readFileSync(resolve(repoRoot, 'web/app/styles/tokens.css'), 'utf8');
const kitCss = readFileSync(resolve(repoRoot, 'packages/plugin-ui-kit/theme.css'), 'utf8');

describe('plugin-ui-kit theme mirrors the host design tokens', () => {
  it('extracts a non-empty token set from both sides', () => {
    // A comparison of two empty records passes forever. Both extractions must find real tokens first.
    expect(themeBlocks(hostCss).length).toBeGreaterThan(0);
    expect(themeBlocks(kitCss).length).toBe(themeBlocks(hostCss).length);
    expect(Object.keys(tokens(hostCss)).length).toBeGreaterThan(20);
  });

  it('carries exactly the host tokens, with the same values', () => {
    expect(tokens(kitCss)).toEqual(tokens(hostCss));
  });

  it('mirrors ONLY the @theme blocks — no `:root` rules that would leak into plugin sheets', () => {
    // tokens.css also carries `:root` and a media query. Those belong to the host document; a plugin
    // sheet referencing them would either emit nothing (harmless) or, if imported by mistake, restate
    // host-level state. Keep the mirror to the part `@reference` is allowed to consume.
    expect(kitCss.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/:root/);
  });
});
