import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPluginUiBundle, buildPluginUiCss } from 'elowen-plugin-ui-kit/build';

/** The plugin-web toolchain's load-bearing invariant: a bundle must NEVER carry its own React — all
 *  react/react-dom/jsx-runtime imports have to collapse into reads of window.ElowenUiRuntime, and the
 *  output must be a single self-contained ESM file (the daemon content-hashes it as-is). */
describe('elowen-plugin-ui-kit build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ui-kit-build-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('bundles TSX to one ESM file with react aliased to the host runtime shims', async () => {
    mkdirSync(join(dir, 'web-src'));
    writeFileSync(join(dir, 'web-src', 'index.tsx'), [
      "import { useState } from 'react';",
      "import { createPortal } from 'react-dom';",
      'function Panel({ plugin }: { plugin: string }) {',
      '  const [n] = useState(0);',
      '  void createPortal;',
      '  return <div data-plugin={plugin}>{n}</div>;',
      '}',
      "window.__elowenRegisterPluginUi!('t', { requiresApiVersion: 1, pages: { '': Panel } });",
    ].join('\n'));

    const outfile = join(dir, 'web', 'index.js');
    await buildPluginUiBundle({ entry: join(dir, 'web-src', 'index.tsx'), outfile });

    const out = readFileSync(outfile, 'utf8');
    // The shims' runtime reads are present; the real React implementation is not.
    expect(out).toContain('window.ElowenUiRuntime');
    expect(out).toContain('runtime.react');
    expect(out).toContain('runtime.reactDom');
    expect(out).toContain('runtime.jsxRuntime');
    expect(out).not.toMatch(/react\.development|__SECRET_INTERNALS|react\.production/);
    // Self-contained ESM: no leftover imports to resolve at load time.
    expect(out).not.toMatch(/^\s*import\s.*from\s+["'](react|react-dom)/m);
  });
});

/** The plugin CSS pipeline. Elowen ships a PREBUILT web app, so the host's stylesheet is frozen at
 *  publish time and carries only the utilities the host itself uses — a registry plugin reaching for any
 *  other one rendered unstyled on a user's machine. `buildPluginUiCss` lets the plugin bring its own
 *  sheet, and the three scoping rules below are what make dropping that sheet into a live app safe. */
describe('elowen-plugin-ui-kit css build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ui-kit-css-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // A MINIFIED bundle, because that is what a plugin actually ships: class names survive as string
  // literals, and the extractor has to pull arbitrary values and variants back out of that soup.
  const bundle = join(dir, 'index.js');
  writeFileSync(bundle, 'var a=`h-36 bg-surface text-text-muted rounded-lg w-[137px] sm:grid-cols-[10rem_minmax(0,1fr)]`;\n');

  let css = '';
  beforeAll(async () => { css = await buildPluginUiCss({ bundle, outfile: join(dir, 'index.css') }); });

  it('emits the utilities the bundle uses, arbitrary values and variants included', () => {
    expect(css).toMatch(/\.h-36\s*\{/);
    expect(css).toMatch(/\.w-\\\[137px\\\]\s*\{\s*width:\s*137px/);
    // The variant survives minification and compiles to its media query.
    expect(css).toContain('sm\\:grid-cols-\\[10rem_minmax\\(0\\,1fr\\)\\]');
    expect(css).toMatch(/@media \(width >= 40rem\)/);
  });

  it('references the host design tokens instead of inlining them, so a skin still moves the plugin', () => {
    // THE regression to watch for. `web/skins/*` repaint by overriding the token variables on
    // `:root[data-skin]`. If the compile ever inlined the theme (an `@import` where an `@reference`
    // belongs), every plugin would freeze on the default palette while the host repainted around it.
    expect(css).toMatch(/\.bg-surface\s*\{\s*background-color:\s*var\(--color-surface,\s*#070707\)/);
    expect(css).toMatch(/\.text-text-muted\s*\{\s*color:\s*var\(--color-text-muted,/);
    expect(css).toMatch(/\.rounded-lg\s*\{\s*border-radius:\s*var\(--radius-lg,/);
    // And it must not have shipped the host's variable DEFINITIONS — that would pin the tokens at the
    // plugin's build-time values for everything downstream of the sheet.
    expect(css).not.toMatch(/^\s*--color-surface:/m);
  });

  it('puts every rule inside @layer utilities', () => {
    // Without the layer, plugin rules would sit unlayered and beat the host's layered utilities globally.
    // The runtime loader inserts this sheet before host styles so equal-specificity host utilities still win.
    expect(css).toContain('@layer utilities {');
    // Strip the layer block(s) and the leading banner comment; nothing rule-shaped may remain outside.
    const outside = stripLayer(css).replace(/\/\*[\s\S]*?\*\//g, '').replace(/@layer [a-z, ]+;/g, '').trim();
    expect(outside).toBe('');
  });

  it('ships no preflight — a plugin must never reset the host document', () => {
    expect(css).not.toMatch(/\*\s*,\s*::before/);
    expect(css).not.toMatch(/\bbox-sizing:\s*border-box/);
    expect(css).not.toMatch(/^\s*(html|body)\s*[,{]/m);
  });

  it('uses no class prefix — the plugin shares class names with the host shared components', () => {
    // A prefixed build would emit `.tw\:h-36`; the shared components a plugin renders from
    // window.ElowenUiRuntime are styled by the HOST's unprefixed sheet, so a prefix would split them.
    expect(css).not.toMatch(/\.[a-z]+\\:h-36/);
    expect(css).toMatch(/\.h-36\s*\{/);
  });
});

/** Remove every top-level `@layer <names> { … }` block, brace-balanced. */
function stripLayer(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf('@layer', i);
    const open = at === -1 ? -1 : css.indexOf('{', at);
    // `@layer a, b;` (the order declaration) has a `;` before its next `{` — not a block, keep it.
    const semi = at === -1 ? -1 : css.indexOf(';', at);
    if (at === -1 || open === -1) { out += css.slice(i); break; }
    if (semi !== -1 && semi < open) { out += css.slice(i, semi + 1); i = semi + 1; continue; }
    out += css.slice(i, at);
    let depth = 0;
    let j = open;
    for (; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}' && --depth === 0) { j++; break; }
    }
    i = j;
  }
  return out;
}
