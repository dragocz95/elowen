import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SKINS } from '../../lib/skins';

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
const SURFACE_TOKENS = ['--color-bg', '--color-document', '--color-surface', '--color-elevated'] as const;
const AA_NORMAL_TEXT = 4.5;

/** The palette a design actually renders with: the base tokens, with a skin's overrides applied on top.
 *  A skin that overrides only the surfaces still has to keep the INHERITED text readable on them, which
 *  is exactly the mistake this resolution order exposes. */
function palette(skin: string | null): Record<string, string> {
  return skin ? { ...baseTokens, ...declarations(skinCss(skin)) } : baseTokens;
}

function assertReadable(design: string, tokens: Record<string, string>) {
  const hex = (token: string) => {
    const value = tokens[token];
    // The contrast gate needs a resolvable colour. A computed value (color-mix, a var() chain) cannot be
    // evaluated here, so a design that reaches for one on a text or surface token must be told loudly
    // rather than silently skipped — a skipped check is how an unreadable palette ships.
    expect(value, `${design}: ${token} is not defined`).toBeTruthy();
    expect(value, `${design}: ${token} must be a literal hex colour so contrast can be verified, got "${value}"`)
      .toMatch(/^#[0-9a-f]{3}([0-9a-f]{3})?$/i);
    return value!;
  };

  for (const text of TEXT_TOKENS) {
    for (const surface of SURFACE_TOKENS) {
      const ratio = contrast(hex(text), hex(surface));
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

  it.each([...SKINS])('skin "%s" uses tokens, not literals, in its structural rules', (skin) => {
    // Drop custom-property declarations: those ARE the token layer and a literal is what they are for.
    const structural = stripComments(skinCss(skin)).replace(/--[a-z0-9-]+\s*:[^;}]+[;]?/gi, '');
    expect([...structural.matchAll(COLOUR_LITERAL)].map((m) => m[0]), `hardcoded colour in ${skin}/skin.css`)
      .toEqual([]);
  });
});
