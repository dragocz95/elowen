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
const brainChatSurface = readFileSync(join(root, 'modules', 'advisor', 'BrainChatSurface.tsx'), 'utf-8');
const skinCss = (skin: string) => readFileSync(join(root, 'skins', skin, 'skin.css'), 'utf-8');
const sharedCss = (sheet: string) => readFileSync(join(root, 'skins', sheet), 'utf-8');
const SHARED_STYLESHEETS = SKIN_FAMILY_SHEETS.flatMap((entry) => [...entry.sharedStylesheets]);

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** A source file with every comment blanked out and the line numbering intact, so a scan reports a
 *  navigable `path:line` and never fires on prose. Shared by the two scanners below, which are looking
 *  for different things — a colour literal and a retired token name — but have the same reason to ignore
 *  what a file says ABOUT a colour. */
function code(text: string, isCss: boolean): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  const out = text.replace(/\/\*[\s\S]*?\*\//g, blank);
  return isCss ? out : out.split('\n').map((line) => (/^\s*\/\//.test(line) ? '' : line)).join('\n');
}

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

const TEXT_TOKENS = ['--color-foreground', '--color-muted-foreground', '--color-subtle-foreground'] as const;
/** Every ground the text ramp is actually painted on. `--color-sticky` is DERIVED rather than
 *  declared (tokens.css mixes 6% ink into the document surface) and is the ground of every sticky table
 *  header and toolbar in the app — and because it is derived it can be lighter than --color-muted,
 *  which is the surface each palette was tuned against. Studio's light variant shipped a header at
 *  4.43:1 that way and no gate saw it, because this list stopped at the four declared surfaces.
 *
 *  `--color-sidebar` and `--color-sidebar-accent` are here for the same reason: the primary navigation
 *  is a whole region of the app painted on grounds a design may set independently of its content
 *  surfaces, and its rows carry the muted and subtle steps. A skin is free to make the column quieter
 *  than the page — it must not make the menu unreadable doing so. */
const SURFACE_TOKENS = ['--color-background', '--color-document', '--color-card', '--color-muted', '--color-sticky', '--color-sidebar', '--color-sidebar-accent'] as const;
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
 *  The one entry left is a defect found by adding --color-sticky to the surfaces above: the derived
 *  sticky ground is LIGHTER than --color-muted, which is the surface the built-in palette states its
 *  measurement against, so the third text step lands just under AA on it. That palette is not this
 *  branch's to repaint, and the correction is a two-unit darkening of one token. (A second entry lived
 *  here for the midnight skin, which had the same defect for the same reason; it went with the skin.) */
const KNOWN_BELOW_AA: { design: string; text: string; surface: string; reason: string }[] = [
  {
    design: 'default',
    text: '--color-subtle-foreground',
    surface: '--color-sticky',
    reason: 'TODO(contrast): #827974 on the derived sticky ground (#121111) is 4.43:1. tokens.css claims 4.57:1 as its worst case, which was measured before --color-sticky existed; darkening the token repaints the built-in design and belongs to its own change.',
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
  const on = (token: string) => contrast(hex(token), hex('--color-muted'));
  expect(on('--color-foreground'), `${design}: --color-foreground must read stronger than --color-muted-foreground`)
    .toBeGreaterThan(on('--color-muted-foreground'));
  expect(on('--color-muted-foreground'), `${design}: --color-muted-foreground must read stronger than --color-subtle-foreground`)
    .toBeGreaterThan(on('--color-subtle-foreground'));
}

/** The shadcn pairing rule, as a measurement. tokens.css states it in prose — "a base token names a
 *  SURFACE and its `-foreground` names the text and icons that sit on it" — and every component is
 *  written against it: `bg-muted text-muted-foreground`, `bg-primary text-primary-foreground`.
 *
 *  It is a SEPARATE check from the ramp above rather than a restatement of it. The ramp measures three
 *  text steps against every ground the app paints; this measures the pairs a shadcn component reaches
 *  for, and the two sets only overlap in part — `card`, `popover`, `primary`, `secondary` and
 *  `destructive` each carry a foreground no ramp step names, and a design is free to move either half of
 *  a pair on its own. `resolveColour` follows whatever `var()` chain a design leaves behind it, so a skin
 *  that re-aliases one of these is measured on what it actually renders.
 *
 *  `accent` is deliberately absent: it is a wash of the foreground (`color-mix(… transparent)`) rather
 *  than an opaque surface, so what it composites over is whatever is behind it — which is the property
 *  that makes it legible on every design by construction, and which no static pair can express. */
const SHADCN_PAIRS = [
  ['--color-background', '--color-foreground'],
  ['--color-card', '--color-card-foreground'],
  ['--color-popover', '--color-popover-foreground'],
  ['--color-primary', '--color-primary-foreground'],
  ['--color-secondary', '--color-secondary-foreground'],
  ['--color-muted', '--color-muted-foreground'],
  ['--color-destructive', '--color-destructive-foreground'],
] as const;

describe('text contrast', () => {
  it('keeps chat metadata on an opaque AA text token at the caption size', () => {
    expect(brainChatSurface).toMatch(/chat-turn-meta[^`]*text-caption[^`]*text-muted-foreground/);
    expect(brainChatSurface).not.toContain('text-muted-foreground/70');
    expect(parseFloat(baseTokens['--text-caption']!)).toBeGreaterThanOrEqual(0.6875);
    for (const skin of [null, ...SKINS]) {
      const tokens = palette(skin);
      const text = resolveColour(tokens['--color-muted-foreground']!, tokens)!;
      for (const surface of ['--color-background', '--color-card', '--color-muted']) {
        const ground = resolveColour(tokens[surface]!, tokens)!;
        expect(contrast(text, ground), `${skin ?? 'default'} chat metadata on ${surface}`).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      }
    }
  });

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
    expect(baseTokens['--color-sticky']).toContain('color-mix');
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

describe('Studio conversation role colours', () => {
  it('keeps user turns blue with white text in both Light and Dark', () => {
    const light = declarations(skinCss('studio-light'));
    const dark = declarations(skinCss('studio-oled'));
    expect(dark['--studio-chat-user-bg']).toBe(light['--studio-chat-user-bg']);
    expect(dark['--studio-chat-user-text']).toBe(light['--studio-chat-user-text']);
    expect(contrast(dark['--studio-chat-user-text']!, dark['--studio-chat-user-bg']!)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });
});

describe('shadcn surface/foreground pairs', () => {
  function assertPairsReadable(design: string, tokens: Record<string, string>) {
    for (const [surface, foreground] of SHADCN_PAIRS) {
      const hex = (token: string) => {
        const value = tokens[token];
        // A pair that names a token nobody declares is a component painting from nothing — the utility
        // resolves to an empty custom property and the element inherits whatever is around it.
        expect(value, `${design}: ${token} is not defined`).toBeTruthy();
        const resolved = resolveColour(value!, tokens);
        expect(resolved, `${design}: ${token} must resolve to a literal colour, got "${value}"`).toMatch(HEX_COLOUR);
        return resolved!;
      };
      const ratio = contrast(hex(foreground), hex(surface));
      expect(
        ratio,
        `${design}: ${foreground} on ${surface} is ${ratio.toFixed(2)}:1, below WCAG AA (${AA_NORMAL_TEXT}:1)`,
      ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  }

  it('the built-in design pairs every surface with a legible foreground', () => {
    assertPairsReadable('default', palette(null));
  });

  it.each([...SKINS])('skin "%s" pairs every surface with a legible foreground', (skin) => {
    assertPairsReadable(skin, palette(skin));
  });

  it('measures the pair a component actually renders, following whatever var() chain a design leaves', () => {
    // The guard is only worth having if it FAILS on an unreadable pair. Two mutations, because the pairs
    // are declared two different ways and a check that only saw the literal one would pass forever on
    // half of them: `muted`/`muted-foreground` both hold their own value, while
    // `destructive-foreground` is an ALIAS of --color-primary-foreground and can only be measured if the
    // resolver follows that hop. A palette where the quiet ink has been lightened onto the card fill, or
    // where the destructive fill has been darkened onto the shared status ink, must not pass.
    const dimInk = { ...baseTokens, '--color-muted-foreground': '#2a2a2a', '--color-muted': '#0d0d0d' };
    expect(() => assertPairsReadable('broken', dimInk)).toThrow(/--color-muted-foreground on --color-muted/);

    // The message matters as much as the throw: a resolver that stopped at the alias would report
    // "must resolve to a literal colour" instead, i.e. it would fail without ever measuring the pair.
    const darkFill = { ...baseTokens, '--color-destructive': '#0a0a0a' };
    expect(() => assertPairsReadable('broken', darkFill))
      .toThrow(/--color-destructive-foreground on --color-destructive is \d/);
  });
});

// ---------------------------------------------------------------------------------------------------
// The retired palette vocabulary
// ---------------------------------------------------------------------------------------------------

/** Every name that used to be a SECOND word for a colour the shadcn vocabulary already had, with the name
 *  that replaced it — or null where there was nothing to replace, because the token was a duplicate or was
 *  read by no one.
 *
 *  The app carried both vocabularies at once for the length of the shadcn migration, aliased to each
 *  other in tokens.css. That is exactly the state this ledger exists to stop coming back: while two names
 *  resolve to one colour, a skin can override the half nobody reads and repaint nothing, and no gate can
 *  tell a correct design from a broken one because both spellings work. */
const RETIRED: { name: string; replacement: string | null; reason?: string }[] = [
  { name: 'bg', replacement: 'background' },
  { name: 'document', replacement: 'document' }, // kept, and here to prove the ledger is not a rubber stamp
  { name: 'surface', replacement: 'card' },
  { name: 'surface-sticky', replacement: 'sticky' },
  { name: 'elevated', replacement: 'muted' },
  { name: 'overlay', replacement: 'popover' },
  { name: 'text', replacement: 'foreground' },
  { name: 'text-muted', replacement: 'muted-foreground' },
  { name: 'text-subtle', replacement: 'subtle-foreground' },
  { name: 'danger', replacement: 'destructive' },
  { name: 'on-status', replacement: 'primary-foreground' },
  { name: 'tone-violet', replacement: 'chart-4' },
  { name: 'tone-magenta', replacement: 'chart-5' },
  { name: 'error', replacement: null, reason: 'An exact duplicate of --color-danger in every design; both are --color-destructive now.' },
  { name: 'approve', replacement: null, reason: 'An exact duplicate of --color-success in every design.' },
  { name: 'cancelled', replacement: null, reason: 'Declared by three designs and read by nothing at all.' },
];

/** `document` is in the ledger deliberately and must NOT be reported as retired — it is the one name from
 *  the old palette that survived, because shadcn has no ground between `background` and `card`. Listing it
 *  is what keeps the ledger honest about the difference. */
const RETIRED_NAMES = RETIRED.filter((entry) => entry.name !== entry.replacement).map((entry) => entry.name);

describe('the retired palette vocabulary cannot come back', () => {
  /** Every stylesheet that declares tokens: the host's, each skin's, and the mirror a plugin bundle is
   *  compiled against — which is the one furthest from anybody's eyes and therefore the likeliest to keep
   *  a name the host has dropped. */
  const tokenSheets: { label: string; css: string }[] = [
    { label: 'app/styles/tokens.css', css: tokensCss },
    ...SKINS.map((skin) => ({ label: `skins/${skin}/skin.css`, css: skinCss(skin) })),
    { label: 'packages/plugin-ui-kit/theme.css', css: readFileSync(join(root, '..', 'packages', 'plugin-ui-kit', 'theme.css'), 'utf-8') },
  ];

  it('states a replacement or a reason for every name it retires', () => {
    // A ledger entry with neither is an assertion nobody can check: the name is banned and the reader has
    // no way to find out what to write instead.
    for (const entry of RETIRED) {
      if (entry.replacement === null) {
        expect(entry.reason, `${entry.name} has no replacement and must say why`).toBeTruthy();
        expect(entry.reason!.length, `${entry.name} records no usable reason`).toBeGreaterThan(30);
      } else {
        expect(baseTokens, `${entry.name} points at --color-${entry.replacement}, which tokens.css does not declare`)
          .toHaveProperty(`--color-${entry.replacement}`);
      }
    }
    expect(RETIRED_NAMES.length, 'the ledger retires nothing — it would pass forever').toBeGreaterThan(10);
  });

  it.each(tokenSheets)('$label declares none of them', ({ label, css }) => {
    // THE load-bearing half. A retired name that is not declared generates no Tailwind utility and
    // resolves to nothing through `var()`, so it cannot be resurrected even by a class assembled at
    // runtime — `bg-${tone}` with a stale `tone` paints nothing rather than painting the old colour.
    const declared = Object.keys(declarations(css));
    const back = RETIRED_NAMES.filter((name) => declared.includes(`--color-${name}`));
    expect(back, `${label} declares a retired token`).toEqual([]);
  });

  /** Utility prefixes a colour name can follow. `outline` is deliberately absent: `outline-danger` is a
   *  variant name in `components/ui/Button.tsx`'s app→shadcn map, not a utility, and banning it here would
   *  be banning a word rather than a colour. The `outline-*` utilities the app does use take a colour that
   *  is not on this list. */
  const PREFIXES = ['bg', 'text', 'border', 'ring', 'from', 'to', 'via', 'fill', 'stroke', 'divide'];

  /** A retired spelling anywhere in a string: `<prefix>-<name>` with no word character or hyphen on either
   *  side, so `text-subtle-foreground` is not read as `text-subtle`, and `--color-<name>` for the CSS side.
   *  It scans raw text rather than JSX attributes on purpose — a ternary, a template literal and a lookup
   *  table are all just strings here, and all three are how these names actually get written. */
  const retiredSpelling = new RegExp(
    `(?<![\\w-])(?:(?:${PREFIXES.join('|')})-(?:${RETIRED_NAMES.join('|')})|--color-(?:${RETIRED_NAMES.join('|')}))(?![\\w-])`,
    'g',
  );

  /** Everything a design has to be able to repaint, plus the plugin bundles that compile against the same
   *  mirror — a plugin spelling a retired name renders unstyled on a user's machine, which is the failure
   *  furthest from anyone who would notice it. */
  function vocabularyFiles(): string[] {
    const walk = (dir: string, match: RegExp, out: string[] = []): string[] => {
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return out; }
      for (const entry of entries) {
        if (entry === 'node_modules') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) { walk(full, match, out); continue; }
        if (match.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
      }
      return out;
    };
    const repo = join(root, '..');
    return [
      ...walk(join(root, 'components'), /\.tsx?$/),
      ...walk(join(root, 'modules'), /\.tsx?$/),
      ...walk(join(root, 'lib'), /\.tsx?$/),
      ...walk(join(root, 'app'), /\.(tsx?|css)$/),
      ...walk(join(root, 'skins'), /\.css$/),
      // Bundle SOURCES only: `plugins/*/web/` holds esbuild output, which would report the same class
      // twice and point at a generated line nobody can edit.
      ...walk(join(repo, 'plugins'), /\.tsx?$/).filter((file) => file.includes('/web-src/')),
    ].sort();
  }

  it('is spelled by no shipped source', () => {
    const offenders = vocabularyFiles().flatMap((file) => {
      const hits: string[] = [];
      // Comments are blanked, line numbers preserved. Prose about the old vocabulary is how the rename is
      // explained — this very ledger, the note in tokens.css saying what these names used to be, a skin's
      // measurement history — and a guard that could not tell a comment from a class name would make
      // recording the change impossible.
      code(readFileSync(file, 'utf-8'), file.endsWith('.css')).split('\n').forEach((line, i) => {
        retiredSpelling.lastIndex = 0;
        for (const hit of line.match(retiredSpelling) ?? []) hits.push(`${relative(root, file)}:${i + 1} ${hit}`);
      });
      return hits;
    });
    expect(offenders, 'these names were retired — see the RETIRED ledger for what replaced each').toEqual([]);
  });

  it('actually scans, and tells a retired spelling from the one that replaced it', () => {
    // A guard that matches nothing, or that matches everything, passes forever either way.
    const files = vocabularyFiles();
    expect(files.length, 'the scan found almost no files — the walk is broken').toBeGreaterThan(50);
    expect(files.some((f) => f.includes('/plugins/')), 'the plugin bundles are not being scanned').toBe(true);

    const flagged = (source: string) => { retiredSpelling.lastIndex = 0; return retiredSpelling.test(source); };
    for (const offender of [
      '<div className="bg-elevated" />',
      '<div className="hover:bg-elevated" />',
      "className={selected ? 'bg-elevated' : 'bg-surface'}",
      'const tone = { danger: "text-danger" };',
      'background: var(--color-text-muted);',
      '<span className="text-text-muted" />',
      '<span className="border-danger/30" />',
      '<span className="text-text" />',
    ]) expect(flagged(offender), `should have been flagged: ${offender}`).toBe(true);

    for (const legitimate of [
      '<div className="bg-muted hover:bg-accent" />',
      '<span className="text-muted-foreground text-subtle-foreground" />',
      '<span className="border-destructive/30 text-destructive" />',
      'background: var(--color-subtle-foreground);',
      'background: var(--color-document);',      // the one old name that survived
      'background: var(--color-sticky);',
      "variant={variant === 'danger' ? 'outline-danger' : 'outline'}", // a Button variant, not a colour
      "const status = 'error';",
      '<div className="context-menu" />',
    ]) expect(flagged(legitimate), `should NOT have been flagged: ${legitimate}`).toBe(false);
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

  /** Sources a skin has to be able to restyle: every component and module, the shared library beneath
   *  them, the stylesheets they use, and the root document — which paints the first frame before any
   *  stylesheet lands. Tests are excluded: a test asserting on a literal is checking the token layer, not
   *  shipping a colour.
   *
   *  `lib/` was outside this scan until now, which made it the one place a colour could be moved to in
   *  order to stop being reported — and it is exactly where the shades that feed a third-party renderer
   *  already live (Monaco, ANSI), so nobody would have looked twice at one more. */
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
      ...walk(join(root, 'lib'), /\.tsx?$/),
      ...walk(join(root, 'app', 'styles'), /\.css$/),
      join(root, 'app', 'layout.tsx'),
    ].sort();
  }

  /** Blank out everything that is not a shipped colour value, preserving line numbers so a report stays
   *  navigable. Comments go through the shared `code()` above — prose about `accent-blue` is not a utility
   *  class. In CSS, `--token: value` declarations go too: those ARE the token layer, and a literal is
   *  exactly what they are for, which is the same carve-out the skin check above makes. */
  function paintable(text: string, isCss: boolean): string {
    const blank = (m: string) => m.replace(/[^\n]/g, ' ');
    const out = code(text, isCss);
    return isCss ? out.replace(/--[a-z0-9-]+\s*:[^;}]+/gi, blank) : out;
  }

  /** A colour written out by hand. Three shapes, and each excludes the token spelling of itself:
   *  - a hex literal, including the `bg-[#a78bfa]` arbitrary-value form;
   *  - `rgb()`/`hsl()` and their alpha variants opened with a NUMBER, so the channel-token idiom
   *    `rgb(var(--primary-rgb) / .16)` — and `color-mix(in srgb, var(--color-warning), …)`, which never
   *    opens with a digit at all — stay clean;
   *  - Tailwind's literal colour utilities: `bg-black`, `text-white`, and the named palette
   *    (`bg-red-500`, `text-slate-400`), all of which bypass the semantic tokens entirely.
   *  The semantic utilities the app actually uses — `bg-primary`, `text-muted-foreground`, `border-destructive` — carry
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
    { path: 'lib/monaco/oledTheme.ts', reason: "Monaco's editor theme is a flat object of literal colours handed to the editor at registration; it cannot read CSS custom properties." },
    { path: 'lib/ansi.ts', reason: 'The sixteen ANSI colours a terminal stream names by index — a fixed standard, not a palette a design owns.' },
    { path: 'components/auth/LoginForm.tsx', reason: "The Microsoft logo's four brand quadrants, which a skin must not recolour." },
    { path: 'modules/settings/providers.tsx', reason: 'Third-party provider brand identity colours.' },
    { path: 'modules/memory/memoryMeta.ts', reason: 'The category swatch is a fixed ten-colour identity ramp, the same kind of palette as Avatar: it identifies a category rather than styling it, so the skin must not move it.' },
    { path: 'app/layout.tsx', reason: 'The anti-FOUC paint: the per-skin root background, color-scheme and themeColor land before any stylesheet, so no token exists yet. It is the only copy — base.css no longer holds one.' },
  ];

  /** Literals that are plain debt, not exemptions — a ledger, in the idiom of `coreCssOwnership.test.ts`.
   *  Each of these should resolve to a token; none has been converted yet. Pinned by equality both ways
   *  at file granularity, so a NEW offending file fails as debt added quietly and a file that has been
   *  cleaned up fails as a stale entry. File granularity rather than `path:line` on purpose: line numbers
   *  churn under every unrelated edit, and a ledger that fails on churn gets deleted rather than paid. */
  //  EMPTY, and it stays that way. Every entry that was here has been paid: the white washes across the
  //  settings surface and the interactive row became `color-mix` of --color-foreground, the black scrims became
  //  --color-background, the status glows resolved to the --color-success / --color-destructive / --color-destructive and
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
      'background: var(--color-sticky);',
      '<div className="bg-primary text-muted-foreground border-destructive" />',
      '<div className="bg-card hover:bg-accent" />',
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
