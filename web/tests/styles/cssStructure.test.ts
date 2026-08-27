import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Structural invariants of the core stylesheets. None of these are style opinions — each one is a
 *  silent-failure mode: CSS has no undefined-variable error, no missing-import error and no way to see
 *  that two rules swapped places, so every one of them ships a broken page with a green test suite. */

const WEB = resolve(process.cwd());
const STYLES = join(WEB, 'app', 'styles');
const COMPONENTS = join(STYLES, 'components');
const GLOBALS = join(WEB, 'app', 'globals.css');

const read = (path: string): string => readFileSync(path, 'utf-8');
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

function walkCss(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkCss(path, out);
    else if (entry.name.endsWith('.css')) out.push(path);
  }
  return out;
}

/** `@import "…";` targets, in source order. */
function imports(css: string): string[] {
  return [...stripComments(css).matchAll(/@import\s+["']([^"']+)["']/g)].map(([, target]) => target!);
}

describe('components.css is nothing but an ordered import list', () => {
  // The split file is the cascade: postcss-import flattens it in place, so the built stylesheet is the
  // concatenation of the parts IN THIS ORDER. A rule dropped into this file instead of a part would sit
  // ahead of every part regardless of where it was typed, which is not what the author would see.
  it('contains only comments and imports', () => {
    const leftovers = stripComments(read(join(STYLES, 'components.css')))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('@import'));
    expect(leftovers).toEqual([]);
  });

  it('imports every part exactly once, and every import resolves', () => {
    const targets = imports(read(join(STYLES, 'components.css')));
    const missing = targets.filter((target) => !existsSync(resolve(STYLES, target)));
    expect(missing, `imported but not on disk: ${missing.join(', ')}`).toEqual([]);

    const duplicated = targets.filter((target, index) => targets.indexOf(target) !== index);
    expect(duplicated, `imported more than once: ${duplicated.join(', ')}`).toEqual([]);

    // The other direction: a part nobody imports is dead CSS that still reads like live CSS.
    const imported = new Set(targets.map((target) => resolve(STYLES, target)));
    const orphans = readdirSync(COMPONENTS)
      .filter((name) => name.endsWith('.css'))
      .map((name) => join(COMPONENTS, name))
      .filter((path) => !imported.has(path));
    expect(orphans, `present in app/styles/components but never imported: ${orphans.join(', ')}`).toEqual([]);
  });
});

describe('globals.css import order', () => {
  // Load-bearing, in both directions: tokens must precede every consumer, and the skins bundle must be
  // LAST — a skin restyles the app purely by overriding tokens and a handful of structural rules, so an
  // import moved below it wins the cascade and the skin silently stops applying to that file.
  it('loads tokens, base, components, animations, markdown and skins in that order', () => {
    const targets = imports(read(GLOBALS)).filter((target) => target !== 'tailwindcss');
    expect(targets).toEqual([
      './styles/tokens.css',
      './styles/base.css',
      './styles/components.css',
      './styles/animations.css',
      './styles/markdown.css',
      '../skins/index.css',
    ]);
  });
});

/** Custom properties that are legitimately NOT declared in tokens.css, with where they come from. An
 *  entry is a claim that something outside the stylesheets sets the value; without the record, the
 *  check below can only be silenced by deleting it. */
const EXTERNALLY_SET: Record<string, string> = {
  '--font-geist-sans': 'next/font, app/layout.tsx',
  '--font-geist-mono': 'next/font, app/layout.tsx',
  '--ui-scale': 'lib/useUiScale.tsx sets it on the document root',
  '--data-table-columns': 'components/ui/DataTable.tsx, inline style per table',
  '--data-table-compact-columns': 'components/ui/DataTable.tsx, inline style per table',
  '--i': 'modules/dashboard/HeroCosmos.tsx, modules/advisor/CommandOrbit.tsx, lib/cosmosFilaments.ts',
  '--k': 'modules/advisor/CommandOrbit.tsx, the arc layout scale',
  '--fx': 'modules/dashboard/HeroCosmos.tsx, modules/advisor/CommandOrbit.tsx, pod entry offset',
  '--fy': 'modules/dashboard/HeroCosmos.tsx, modules/advisor/CommandOrbit.tsx, pod entry offset',
  '--live-ring': 'per-instance override hook on .live-dot; unset by default, hence the literal fallback',
};

describe('every custom property the stylesheets read is defined', () => {
  // CSS resolves an unknown var() to the initial value and reports nothing, so a typo like `var(--border)`
  // for `var(--color-border)` renders a borderless box forever without failing a build or a test. This
  // check is the only thing that sees it.
  it('resolves every var() against tokens.css or a recorded external setter', () => {
    const tokens = new Set(
      [...read(join(STYLES, 'tokens.css')).matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map(([, name]) => name!),
    );
    expect(tokens.size).toBeGreaterThan(50);

    const undefinedRefs: string[] = [];
    for (const file of [GLOBALS, ...walkCss(STYLES)]) {
      const css = read(file);
      // A locally declared property is in scope for the rest of its own file's rules.
      const local = new Set([...css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map(([, name]) => name!));
      for (const [, name] of css.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
        if (tokens.has(name!) || local.has(name!) || name! in EXTERNALLY_SET) continue;
        undefinedRefs.push(`${file.slice(WEB.length + 1)}: var(${name})`);
      }
    }
    expect([...new Set(undefinedRefs)]).toEqual([]);
  });
});
