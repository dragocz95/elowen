import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The record card's control column must be capped against the CARD, not only in rem.
 *
 *  A bare `minmax(0, 20rem)` is not a ceiling on a surface narrower than 20rem. A control that asks for
 *  its whole track — a slider is `width: 100%` — takes the maximum, and a non-flexible maximum is
 *  satisfied before the label's `1fr` sees any space. Measured in the real user drawer at a 390px
 *  viewport: card 348px, control column 320px, label column 12px, which stood a two-word Czech label
 *  seven lines tall next to a switch 36px wide.
 *
 *  This is a silent failure mode — a grid that starves one track still lays out and still passes every
 *  jsdom test, because jsdom has no layout — so the cap is pinned as text here. */
const CSS = readFileSync(join(resolve(process.cwd()), 'skins', 'studio', 'surfaces.css'), 'utf-8');
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('studio record card control track', () => {
  it('caps the control column against the card as well as in rem', () => {
    // The `.segmented` variant is deliberately excluded: a three-option set cannot be told to fit, so its
    // track is floored at `min-content` on purpose and a card cap would clip it.
    const declarations = stripComments(CSS)
      .split('}')
      .filter((block) => block.includes('.settings-group__body:has(> .settings-row)')
        && block.includes('grid-template-columns')
        && !block.includes('.segmented'))
      .map((block) => block.slice(block.indexOf('grid-template-columns')));
    const ceilings = declarations.filter((declaration) => declaration.includes('rem'));
    expect(ceilings.length).toBeGreaterThan(0);
    for (const ceiling of ceilings) {
      expect(ceiling, 'a rem-only ceiling starves the label column on a narrow card')
        .toMatch(/minmax\(0, min\(\d+rem, \d+%\)\)/);
    }
  });
});
