import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { SKINS, SKIN_FAMILY_SHEETS } from '../../lib/skins';

// The design system's numeric invariants. Every other token test in the repo checks that a token EXISTS
// or that two files agree on its text; none of them checks what the values actually do on screen. These
// do: a palette edit that drops metadata text below WCAG AA, a skin override aimed at a token that no
// longer exists (a silent no-op), or a colour literal baked into a skin's structural rules where a token
// belongs are all invisible in review and all caught here.
//
// Everything is generic over `SKINS`, so a deployment fork that adds its own skin inherits the checks
// without editing this file.

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tokensCss = readFileSync(join(root, 'app', 'styles', 'tokens.css'), 'utf-8');
const skinCss = (skin: string) => readFileSync(join(root, 'skins', skin, 'skin.css'), 'utf-8');
const sharedCss = (sheet: string) => readFileSync(join(root, 'skins', sheet), 'utf-8');
const SHARED_STYLESHEETS = SKIN_FAMILY_SHEETS.flatMap((entry) => [...entry.sharedStylesheets]);

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every `--token: value` declaration in a stylesheet, last one winning — which is the cascade's own
 *  answer for a single-selector file like a skin's token block. */
function declarations(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, key, value] of stripComments(css).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)[;}]/gi)) {
    out[key] = value.trim();
  }
  return out;
}

const baseTokens = declarations(tokensCss);

// ---------------------------------------------------------------------------------------------------
// WCAG contrast
// ---------------------------------------------------------------------------------------------------

const channel = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/** WCAG relative luminance of a `#rgb`/`#rrggbb` colour. */
function luminance(hex: string): number {
  const h = hex.trim().replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(full.slice(i, i + 2), 16) / 255));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG 2.x contrast ratio, 1..21. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT_TOKENS = ['--color-text', '--color-text-muted', '--color-text-subtle'] as const;
/** Every ground the text ramp is actually painted on. `--color-surface-sticky` is DERIVED rather than
 *  declared (tokens.css mixes 6% ink into the document surface) and is the ground of every sticky table
 *  header and toolbar in the app — and because it is derived it can be lighter than --color-elevated,
 *  which is the surface each palette was tuned against. Studio's light variant shipped a header at
 *  4.43:1 that way and no gate saw it, because this list stopped at the four declared surfaces.
 *
 *  `--color-sidebar` and `--color-sidebar-accent` are here for the same reason: the primary navigation
 *  is a whole region of the app painted on grounds a design may set independently of its content
 *  surfaces, and its rows carry the muted and subtle steps. A skin is free to make the column quieter
 *  than the page — it must not make the menu unreadable doing so. */
const SURFACE_TOKENS = ['--color-bg', '--color-document', '--color-surface', '--color-elevated', '--color-surface-sticky', '--color-sidebar', '--color-sidebar-accent'] as const;
const AA_NORMAL_TEXT = 4.5;

/** Mix two `#rrggbb` colours the way `color-mix(in srgb, …)` does: a linear interpolation of the
 *  gamma-encoded channels, `weight` being the share of the first colour. */
function mixSrgb(a: string, b: string, weight: number): string {
  const channels = (hex: string) => {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  };
  const [from, to] = [channels(a), channels(b)];
  return `#${from.map((v, i) => Math.round(v * weight + to[i]! * (1 - weight)).toString(16).padStart(2, '0')).join('')}`;
}

const HEX_COLOUR = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i;

/** A token's value as a literal colour, following `var()` chains and evaluating the one derivation the
 *  palettes use. Without this a derived surface could not be measured at all, and "cannot measure" is
 *  how an unreadable pair ships: the header above is exactly that case. */
function resolveColour(value: string, tokens: Record<string, string>, depth = 0): string | null {
  const raw = value.trim();
  if (HEX_COLOUR.test(raw)) return raw;
  if (depth > 8) return null;
  const reference = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(raw);
  if (reference) {
    const next = tokens[reference[1]!];
    return next === undefined ? null : resolveColour(next, tokens, depth + 1);
  }
  const mix = /^color-mix\(\s*in\s+srgb\s*,\s*(.+?)\s+([\d.]+)%\s*,\s*(.+?)(?:\s+[\d.]+%)?\s*\)$/i.exec(raw);
  if (mix) {
    const [from, to] = [resolveColour(mix[1]!, tokens, depth + 1), resolveColour(mix[3]!, tokens, depth + 1)];
    return from && to ? mixSrgb(from, to, Number(mix[2]) / 100) : null;
  }
  return null;
}

/** Text/ground pairs that are below AA TODAY, each with the reason it is not fixed here. A ledger in the
 *  idiom this file already uses for hardcoded colours, and pinned in both directions: an entry whose
 *  ratio has since been fixed fails as a stale entry, and a pair that is not listed has to pass. So the
 *  list can only shrink, and adding to it is a visible act rather than a quiet one.
 *
 *  Both entries are the same defect, found by adding --color-surface-sticky to the surfaces above: the
 *  derived sticky ground is LIGHTER than --color-elevated, which is the surface both of these palettes
 *  state their measurement against, so the third text step lands just under AA on it. Neither palette is
 *  this branch's to repaint — Studio must leave the built-in design and midnight pixel-identical — and
 *  the correction is a two-unit darkening of one token in each. */
const KNOWN_BELOW_AA: { design: string; text: string; surface: string; reason: string }[] = [
  {
    design: 'default',
    text: '--color-text-subtle',
    surface: '--color-surface-sticky',
    reason: 'TODO(contrast): #827974 on the derived sticky ground (#121111) is 4.43:1. tokens.css claims 4.57:1 as its worst case, which was measured before --color-surface-sticky existed; darkening the token repaints the built-in design and belongs to its own change.',
  },
  {
    design: 'midnight',
    text: '--color-text-subtle',
    surface: '--color-surface-sticky',
    reason: 'TODO(contrast): #77808f on the derived sticky ground (#15181e) is 4.46:1, for the same reason as the built-in design above — the skin was tuned against --color-elevated, which the derived surface is lighter than.',
  },
];

/** The palette a design actually renders with: the base tokens, with a skin's overrides applied on top.
 *  A skin that overrides only the surfaces still has to keep the INHERITED text readable on them, which
 *  is exactly the mistake this resolution order exposes. */
function palette(skin: string | null): Record<string, string> {
  return skin ? { ...baseTokens, ...declarations(skinCss(skin)) } : baseTokens;
}

function assertReadable(design: string, tokens: Record<string, string>) {
  const hex = (token: string) => {
    const value = tokens[token];
    // The contrast gate needs a resolvable colour. A value it cannot evaluate must be told loudly rather
    // than silently skipped — a skipped check is how an unreadable palette ships.
    expect(value, `${design}: ${token} is not defined`).toBeTruthy();
    const resolved = resolveColour(value!, tokens);
    expect(resolved, `${design}: ${token} must resolve to a literal colour so contrast can be verified, got "${value}"`)
      .toMatch(/^#[0-9a-f]{3}([0-9a-f]{3})?$/i);
    return resolved!;
  };

  for (const text of TEXT_TOKENS) {
    for (const surface of SURFACE_TOKENS) {
      const ratio = contrast(hex(text), hex(surface));
      const known = KNOWN_BELOW_AA.find((e) => e.design === design && e.text === text && e.surface === surface);
      if (known) {
        // The other direction of the ledger: once the pair clears AA its entry is stale, and a stale
        // exemption is how a list like this stops meaning anything.
        expect(
          ratio,
          `${design}: ${text} on ${surface} is now ${ratio.toFixed(2)}:1 — delete its KNOWN_BELOW_AA entry`,
        ).toBeLessThan(AA_NORMAL_TEXT);
        continue;
      }
      expect(
        ratio,
        `${design}: ${text} on ${surface} is ${ratio.toFixed(2)}:1, below WCAG AA (${AA_NORMAL_TEXT}:1)`,
      ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  }

  // Three steps that all pass AA but read the same are not a hierarchy. Compare on the LIGHTEST surface,
  // where the steps are closest together.
  const on = (token: string) => contrast(hex(token), hex('--color-elevated'));
  expect(on('--color-text'), `${design}: --color-text must read stronger than --color-text-muted`)
    .toBeGreaterThan(on('--color-text-muted'));
  expect(on('--color-text-muted'), `${design}: --color-text-muted must read stronger than --color-text-subtle`)
    .toBeGreaterThan(on('--color-text-subtle'));
}

describe('text contrast', () => {
  it('resolves a derived surface rather than skipping it', () => {
    // The resolver is load-bearing: if it silently returned null for a `color-mix` the gate would fail
    // loudly, but if it returned the wrong colour the gate would measure a surface nobody renders.
    expect(resolveColour('#abc', {})).toBe('#abc');
    expect(resolveColour('var(--a)', { '--a': '#123456' })).toBe('#123456');
    expect(resolveColour('color-mix(in srgb, var(--doc) 94%, var(--ink) 6%)', { '--doc': '#ffffff', '--ink': '#09090b' })).toBe('#f0f0f0');
    expect(resolveColour('color-mix(in srgb, #000000 50%, #ffffff)', {})).toBe('#808080');
    expect(resolveColour('var(--missing)', {})).toBeNull();
    // And the surface it was added for really is derived in every design, i.e. the check below is not
    // quietly measuring a literal somebody declared.
    expect(baseTokens['--color-surface-sticky']).toContain('color-mix');
  });

  it('records only real, still-failing pairs in the ledger', () => {
    for (const entry of KNOWN_BELOW_AA) {
      expect(['default', ...SKINS], `${entry.design} is not a design`).toContain(entry.design);
      expect(TEXT_TOKENS as readonly string[], `${entry.text} is not a text token`).toContain(entry.text);
      expect(SURFACE_TOKENS as readonly string[], `${entry.surface} is not a surface token`).toContain(entry.surface);
      expect(entry.reason, `${entry.design}/${entry.text} must say why it is not fixed`).toMatch(/^TODO\(contrast\): /);
    }
  });

  it('the built-in design keeps every text step at WCAG AA on every surface', () => {
    assertReadable('default', palette(null));
  });

  it.each([...SKINS])('skin "%s" keeps every text step at WCAG AA on its own surfaces', (skin) => {
    assertReadable(skin, palette(skin));
  });
});

// ---------------------------------------------------------------------------------------------------
// Skin override validity
// ---------------------------------------------------------------------------------------------------

describe('skin token overrides', () => {
  // A skin restyles the app by overriding tokens the utilities already reference. An override of a token
  // the host does not define is not an error anywhere — CSS happily declares an unused custom property —
  // it simply does nothing, so a typo or a token renamed upstream degrades the skin in total silence.
  const MIRRORED_PREFIXES = ['--color-', '--radius-', '--shadow-'];

  it.each([...SKINS])('every token skin "%s" overrides exists in tokens.css', (skin) => {
    const unknown = Object.keys(declarations(skinCss(skin)))
      .filter((token) => MIRRORED_PREFIXES.some((prefix) => token.startsWith(prefix)))
      .filter((token) => !(token in baseTokens));
    expect(unknown, `skin "${skin}" overrides tokens that tokens.css does not define`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
// No hardcoded colour
// ---------------------------------------------------------------------------------------------------

describe('no hardcoded colour outside the token layer', () => {
  // Colour literals belong in exactly two places: the `@theme`/`:root` blocks of tokens.css, and a skin's
  // own token block. Anywhere else — a structural rule in a skin — the literal is frozen: it survives
  // every repaint and every other skin's overrides, which is precisely the failure the token indirection
  // exists to prevent. A structural rule must reach for `var(--color-*)`.
  const COLOUR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\s*\(/gi;

  /** Colour literals in everything but the custom-property declarations: those ARE the token layer and a
   *  literal is what they are for. */
  const structuralLiterals = (css: string): string[] => {
    const structural = stripComments(css).replace(/--[a-z0-9-]+\s*:[^;}]+[;]?/gi, '');
    return [...structural.matchAll(COLOUR_LITERAL)].map((m) => m[0]);
  };

  it.each([...SKINS])('skin "%s" uses tokens, not literals, in its structural rules', (skin) => {
    expect(structuralLiterals(skinCss(skin)), `hardcoded colour in ${skin}/skin.css`).toEqual([]);
  });

  // A family's shared stylesheet is structure by definition — it carries no token block at all, because a
  // token there would be frozen against whichever variant is on. It needs the same check for the same
  // reason, and it is not a SKINS entry so the check above never sees it.
  it.each(SHARED_STYLESHEETS)('shared stylesheet "%s" uses tokens, not literals', (sheet) => {
    expect(structuralLiterals(sharedCss(sheet)), `hardcoded colour in skins/${sheet}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
// No hardcoded colour in the host component tree
// ---------------------------------------------------------------------------------------------------

describe('the host component tree paints from tokens, not from literals', () => {
  // The same invariant the check above enforces for a skin's own stylesheet, applied to the code that
  // stylesheet has to be able to restyle. `tests/contract/pluginBundleDesignTokens.test.ts` has enforced
  // it for plugin bundles for a while; the HOST had nothing — no stylelint, no eslint colour rule — so a
  // literal in a component was caught only by someone noticing it in review. That is the wrong half to
  // leave open: a plugin's stray colour discolours one panel, a component's discolours the whole app for
  // every skin at once, and it is invisible until someone switches skin and finds one frozen surface.
  //
  // The scan is deliberately mechanical. The answer to "this shade has no token" is to add the token
  // (which a skin can then move) rather than to write the shade where no skin can reach it.

  /** Sources a skin has to be able to restyle: every component and module, the stylesheets they use, and
   *  the root document — which paints the first frame before any stylesheet lands. Tests are excluded:
   *  a test asserting on a literal is checking the token layer, not shipping a colour. */
  function scannedFiles(): string[] {
    const walk = (dir: string, match: RegExp, out: string[] = []): string[] => {
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return out; }
      for (const entry of entries) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) { walk(full, match, out); continue; }
        if (match.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
      }
      return out;
    };
    return [
      ...walk(join(root, 'components'), /\.tsx?$/),
      ...walk(join(root, 'modules'), /\.tsx?$/),
      ...walk(join(root, 'app', 'styles'), /\.css$/),
      join(root, 'app', 'layout.tsx'),
    ].sort();
  }

  /** Blank out everything that is not a shipped colour value, preserving line numbers so a report stays
   *  navigable. Comments go in both languages — prose about `accent-blue` is not a utility class. In CSS,
   *  `--token: value` declarations go too: those ARE the token layer, and a literal is exactly what they
   *  are for, which is the same carve-out the skin check above makes. */
  function paintable(text: string, isCss: boolean): string {
    const blank = (m: string) => m.replace(/[^\n]/g, ' ');
    let out = text.replace(/\/\*[\s\S]*?\*\//g, blank);
    if (isCss) out = out.replace(/--[a-z0-9-]+\s*:[^;}]+/gi, blank);
    else out = out.split('\n').map((line) => (/^\s*\/\//.test(line) ? '' : line)).join('\n');
    return out;
  }

  /** A colour written out by hand. Three shapes, and each excludes the token spelling of itself:
   *  - a hex literal, including the `bg-[#a78bfa]` arbitrary-value form;
   *  - `rgb()`/`hsl()` and their alpha variants opened with a NUMBER, so the channel-token idiom
   *    `rgb(var(--primary-rgb) / .16)` — and `color-mix(in srgb, var(--color-warning), …)`, which never
   *    opens with a digit at all — stay clean;
   *  - Tailwind's literal colour utilities: `bg-black`, `text-white`, and the named palette
   *    (`bg-red-500`, `text-slate-400`), all of which bypass the semantic tokens entirely.
   *  The semantic utilities the app actually uses — `bg-primary`, `text-muted`, `border-danger` — carry
   *  no palette name and so match none of these. */
  const LITERAL_PATTERNS = [
    /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g,
    /\b(?:rgba?|hsla?)\(\s*[0-9.]/g,
    /\b(?:bg|text|border|from|via|to|ring|fill|stroke|outline|caret|placeholder|shadow)-(?:black|white|slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?\b/g,
  ];

  /** Every hardcoded colour in one file, as `path:line literal`. */
  function literalsIn(file: string): string[] {
    const hits: string[] = [];
    const lines = paintable(readFileSync(file, 'utf-8'), file.endsWith('.css')).split('\n');
    lines.forEach((line, i) => {
      for (const pattern of LITERAL_PATTERNS) {
        pattern.lastIndex = 0;
        for (const hit of line.match(pattern) ?? []) hits.push(`${relative(root, file)}:${i + 1} ${hit}`);
      }
    });
    return hits;
  }

  /** Files whose colours genuinely cannot come from a custom property. Each carries its reason inline
   *  and the shape is enforced below, so an exemption without a stated justification cannot exist —
   *  a bare path is how an allowlist quietly becomes the place violations go to die. */
  const EXEMPT: { path: string; reason: string }[] = [
    { path: 'components/terminal/xtermTheme.ts', reason: "xterm's renderer takes a colour object and cannot read CSS custom properties." },
    { path: 'components/terminal/palettes.ts', reason: 'The terminal colour schemes fed to that same xterm colour object.' },
    { path: 'components/auth/LoginForm.tsx', reason: "The Microsoft logo's four brand quadrants, which a skin must not recolour." },
    { path: 'modules/settings/providers.tsx', reason: 'Third-party provider brand identity colours.' },
    { path: 'components/ui/Avatar.tsx', reason: 'The monogram sits on a fixed eight-colour identity palette that deliberately ignores the skin, so its ink has to be equally fixed.' },
    { path: 'modules/memory/memoryMeta.ts', reason: 'The category swatch is a fixed ten-colour identity ramp, the same kind of palette as Avatar: it identifies a category rather than styling it, so the skin must not move it.' },
    { path: 'app/layout.tsx', reason: 'The anti-FOUC paint: the per-skin root background, color-scheme and themeColor land before any stylesheet, so no token exists yet. It is the only copy — base.css no longer holds one.' },
  ];

  /** Literals that are plain debt, not exemptions — a ledger, in the idiom of `coreCssOwnership.test.ts`.
   *  Each of these should resolve to a token; none has been converted yet. Pinned by equality both ways
   *  at file granularity, so a NEW offending file fails as debt added quietly and a file that has been
   *  cleaned up fails as a stale entry. File granularity rather than `path:line` on purpose: line numbers
   *  churn under every unrelated edit, and a ledger that fails on churn gets deleted rather than paid. */
  //  EMPTY, and it stays that way. Every entry that was here has been paid: the white washes across the
  //  settings surface and the interactive row became `color-mix` of --color-text, the black scrims became
  //  --color-bg, the status glows resolved to the --color-success / --color-danger / --color-error and
  //  --color-ember tokens they were already spelling out by hand, the diagnostics legend got the two
  //  categorical tone tokens it needed, and the terminal preview now asks xtermTheme for the background
  //  it tints itself against instead of writing its own. Adding a line here again means a literal is
  //  shipping in the component tree — say why in the reason, and mean "not yet", not "never".
  const DEBT: { path: string; reason: string }[] = [];

  const recorded = new Map([...EXEMPT, ...DEBT].map((entry) => [entry.path, entry] as const));

  it('records a stated reason for every path it excuses', () => {
    // An entry with no reason is an unfalsifiable exemption, and this list is the one place where one
    // would silently keep a hardcoded colour alive forever.
    expect(recorded.size, 'a path is recorded twice').toBe(EXEMPT.length + DEBT.length);
    for (const entry of recorded.values()) {
      expect(entry.reason.length, `${entry.path} records no usable reason`).toBeGreaterThan(30);
      expect(entry.reason, `${entry.path} reason must be a sentence`).toMatch(/\.$/);
    }
    for (const entry of DEBT) {
      expect(entry.reason, `${entry.path} is debt and must be marked as such`).toMatch(/^TODO\(redesign\): /);
    }
  });

  it('actually scans the component tree', () => {
    // A guard that matches nothing passes forever. Both halves are load-bearing: the corpus has to be
    // real (a broken walk or a moved folder collapses it silently), and the matcher has to fire on a
    // colour it has never seen while leaving the token spellings alone.
    const files = scannedFiles();
    expect(files.length, 'the scan found almost no files — the walk is broken').toBeGreaterThan(50);

    const flagged = (source: string) => LITERAL_PATTERNS.some((p) => { p.lastIndex = 0; return p.test(source); });
    for (const offender of [
      'color: #1e90ff;',
      'background: rgba(12, 14, 18, 0.4);',
      'border-color: hsl(210 40% 50%);',
      '<div className="bg-black text-sm" />',
      '<div className="text-white" />',
      '<div className="border-white/10" />',
      '<div className="bg-gradient-to-r from-black to-transparent" />',
      '<div className="bg-red-500" />',
      '<span className="text-slate-400" />',
      '<span className="bg-[#a78bfa]" />',
    ]) expect(flagged(offender), `should have been flagged: ${offender}`).toBe(true);

    for (const legitimate of [
      'background: rgb(var(--primary-rgb) / .16);',
      'border-color: color-mix(in srgb, var(--color-warning) 40%, transparent);',
      'background: var(--color-surface-sticky);',
      '<div className="bg-primary text-muted border-danger" />',
      '<div className="bg-surface hover:bg-elevated" />',
      'const gap = "gap-3 pt-2";',
    ]) expect(flagged(legitimate), `should NOT have been flagged: ${legitimate}`).toBe(false);
  });

  it('has no hardcoded colour outside the recorded paths', () => {
    const offenders = scannedFiles()
      .filter((file) => !recorded.has(relative(root, file)))
      .flatMap(literalsIn);
    expect(offenders, 'a skin cannot restyle these — resolve them from a semantic token').toEqual([]);
  });

  it('carries exactly the recorded set of files that still hold a literal', () => {
    // Equality both ways, the same way `coreCssOwnership.test.ts` pins its ledger: a NEW file with a
    // literal fails as debt added quietly, and a recorded file that no longer has one fails as a stale
    // entry — so cleaning a file up means deleting its line here, and the list can only shrink.
    const holding = scannedFiles().filter((file) => literalsIn(file).length > 0).map((file) => relative(root, file)).sort();
    expect(holding).toEqual([...recorded.keys()].sort());
  });
});
