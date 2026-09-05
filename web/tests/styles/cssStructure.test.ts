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

/** `--token: value` declarations of a stylesheet, last one winning. */
function declarations(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, value] of stripComments(css).matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;}]+)[;}]/g)) {
    out[name!] = value!.trim();
  }
  return out;
}

/** Escape a selector so it can be matched literally inside a regular expression. */
const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every `font-size` a stylesheet gives one selector, in source order — one entry per rule that sizes it.
 *  Empty means the stylesheet does not size that element at all, which is a different answer from "sizes
 *  it from the token" and the two must not be confused. */
function fontSizesFor(css: string, selector: string): string[] {
  const pattern = new RegExp(`${literal(selector)}[^{}]*\\{([^}]*)\\}`, 'g');
  return [...stripComments(css).matchAll(pattern)]
    .flatMap(([, body]) => [...body!.matchAll(/font-size\s*:\s*([^;}]+)/g)].map(([, value]) => value!.trim()));
}

/** The steps of the type scale, measured off the reference dashboard (plans/cloudflare-sidebar-spec.md).
 *  A step is a SET of declarations, not a size: the failure this pins is a rule that picks up three
 *  quarters of one, because CSS says nothing when a heading takes a 30px size and inherits whatever
 *  weight happened to be around it. */
const TYPE_STEPS = ['page-title', 'section-title', 'card-title', 'meta', 'body'] as const;

describe('the type scale', () => {
  const tokens = declarations(read(join(STYLES, 'tokens.css')));

  it('gives every step a size, a line height and a weight', () => {
    const incomplete = TYPE_STEPS.filter((step) => (
      !tokens[`--text-${step}`] || !tokens[`--text-${step}--line-height`] || !tokens[`--text-${step}--font-weight`]
    ));
    expect(incomplete, 'a step missing part of itself is a heading assembled by accident').toEqual([]);
  });

  it('holds the measured values the reference sets', () => {
    // Pinned by value on purpose. The scale is a decision about the app's appearance, so moving a step is
    // an edit to this line as well — which is what stops it drifting one rule at a time.
    expect(tokens['--text-page-title']).toBe('1.875rem');              // 30px
    expect(tokens['--text-page-title--line-height']).toBe('2.25rem');  // 36px
    expect(tokens['--text-page-title--font-weight']).toBe('600');
    expect(tokens['--text-section-title']).toBe('1rem');               // 16px
    expect(tokens['--text-section-title--font-weight']).toBe('600');
    expect(tokens['--text-card-title']).toBe('0.875rem');              // 14px
    expect(tokens['--text-card-title--font-weight']).toBe('500');
    expect(tokens['--text-meta']).toBe('0.8125rem');                   // 13px
    expect(tokens['--text-meta--font-weight']).toBe('400');
    expect(tokens['--text-body']).toBe('1rem');                        // 16px
    expect(tokens['--text-body--line-height']).toBe('1.5rem');         // 24px
  });

  it('tracks by RATIO everywhere except the page title, which the reference states absolutely', () => {
    // -0.01em is the reference's -0.16px at 16px and its -0.13px at 13px, which is why one token can
    // carry both. At 30px the same ratio gives -0.3px while the reference still runs -0.16px, so the
    // page title is the one step that states its tracking in pixels — and the only one allowed to.
    expect(tokens['--tracking-ui']).toBe('-0.01em');
    expect(tokens['--text-page-title--letter-spacing']).toBe('-0.16px');
    const absolute = TYPE_STEPS.filter((step) => step !== 'page-title' && tokens[`--text-${step}--letter-spacing`]);
    expect(absolute, 'these steps would stop following a root font-size change').toEqual([]);
  });

  it('restates the tracking ratio wherever it changes the size', () => {
    // `letter-spacing` inherits as a COMPUTED LENGTH: the `em` on <body> resolves once against 16px and
    // every descendant inherits the resulting -0.16px, whatever size it is set at. Chromium measured the
    // 13px metadata line at -0.16px, where the reference runs -0.13px. A rule that moves the size has to
    // ask for the ratio again, so this pins the ask rather than the pixel it happens to produce.
    const deck = stripComments(read(join(COMPONENTS, 'spatial-deck.css')));
    const sized = [...deck.matchAll(/\{([^}]*font-size:\s*var\(--text-(?:section-title|card-title|meta)\)[^}]*)\}/g)];
    expect(sized.length, 'no rule in the deck reads a scale step — the scan is broken').toBeGreaterThan(3);
    const untracked = sized.filter(([, body]) => !body!.includes('letter-spacing: var(--tracking-ui)'));
    expect(untracked.map(([rule]) => rule), 'these would inherit the 16px tracking at their own size').toEqual([]);
  });

  it('is what the shared surfaces actually read, so no page states a heading of its own', () => {
    // The tokens existing proves nothing: a scale nobody reads is a scale nobody follows. These are the
    // four shared surfaces every page's type comes through — the document, the page title, the section
    // card's heading and its records.
    expect(read(join(STYLES, 'base.css'))).toContain('font-size: var(--text-body)');
    expect(fontSizesFor(read(join(COMPONENTS, 'workspace-hero.css')), '.workspace-hero h1'))
      .toEqual(['var(--text-page-title)']);
    const deck = read(join(COMPONENTS, 'spatial-deck.css'));
    expect(fontSizesFor(deck, '.settings-group__heading h2')).toEqual(['var(--text-section-title)']);
    expect(fontSizesFor(deck, '.settings-row__title')).toEqual(['var(--text-card-title)']);
    expect(fontSizesFor(deck, '.settings-group__heading p')).toEqual(['var(--text-meta)']);
  });

  it('reads a literal size as a literal, so the check above cannot pass on a fork', () => {
    // The extractor IS the guard. If it returned nothing for a rule that sizes an element, every
    // assertion above would be comparing two empty lists and a forked heading would ship green.
    expect(fontSizesFor('.a h1 { font-size: 1.5rem; font-weight: 400; }', '.a h1')).toEqual(['1.5rem']);
    expect(fontSizesFor(':root[data-skin=\'x\'] .a h1 { font-size: var(--text-page-title); }', '.a h1'))
      .toEqual(['var(--text-page-title)']);
    expect(fontSizesFor('/* .a h1 { font-size: 2rem; } */ .a h1 { color: red; }', '.a h1')).toEqual([]);
    expect(fontSizesFor('.b h1 { font-size: 2rem; }', '.a h1')).toEqual([]);
  });
});

/** Custom properties that are legitimately NOT declared in tokens.css, with where they come from. An
 *  entry is a claim that something outside the stylesheets sets the value; without the record, the
 *  check below can only be silenced by deleting it. */
const EXTERNALLY_SET: Record<string, string> = {
  // `--font-geist-sans` is deliberately NOT recorded here any more: Geist Sans is no longer loaded, and
  // the name survives in tokens.css as a compatibility alias onto Inter for plugin sheets that still
  // spell it. It resolves as an ordinary token now, not as something set from outside the stylesheets.
  '--font-geist-mono': 'next/font, app/layout.tsx',
  '--ui-scale': 'lib/useUiScale.tsx sets it on the document root',
  '--data-table-columns': 'components/ui/DataTable.tsx, inline style per table',
  '--data-table-compact-columns': 'components/ui/DataTable.tsx, inline style per table',
  '--data-table-mobile-columns': 'components/ui/DataTable.tsx, inline style per table',
  // Viewport/composer measurements owned by BrainChatSurface's layout effect, not global design tokens.
  '--chat-visual-bottom-offset': 'modules/advisor/BrainChatSurface.tsx useLayoutEffect sets it on the chat surface',
  '--chat-composer-height': 'modules/advisor/BrainChatSurface.tsx useLayoutEffect sets it on the chat surface',
  // A docked plugin live view (today the browser monitor) publishes its own measured height on the chat
  // surface. The core only ever READS this one — the plugin is the setter — and it is absent whenever
  // nothing is docked, which is what the 0px fallback at every read site is for.
  '--chat-dock-height': 'the browser plugin bundle sets it on .chat-surface-full (plugins/browser/web-src)',
  '--chat-dock-reserve': 'modules/advisor/BrainChatSurface.tsx useLayoutEffect sets it on the transcript',
  // The card's measured WIDTH, and where the wrap spacer starts inside the last prose block. The plugin
  // publishes only its height, so the core measures the rest and drives the float from these two.
  '--chat-dock-width': 'modules/advisor/BrainChatSurface.tsx useLayoutEffect sets it on the chat surface',
  '--chat-dock-spacer-top': 'modules/advisor/BrainChatSurface.tsx useLayoutEffect sets it on the wrapped prose block',
  // The entrance stagger's index, handed down per element by the component that knows the order
  // (SidebarNav rows, DashBento cards). There is no global value it could have.
  '--stagger': 'components/shell/SidebarNav.tsx and modules/dashboard/DashBento.tsx, inline style per element',
  // Radix publishes the measured height of a collapsible's content on the content element itself, which
  // is the only way to animate a fold open from zero without hard-coding a height per sub-menu.
  '--radix-collapsible-content-height': '@radix-ui/react-collapsible sets it on [data-slot="collapsible-content"]',
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
