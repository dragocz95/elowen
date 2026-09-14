import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** A Project card's controls need a target a finger can hit.
 *
 *  Every one of them is drawn for a mouse, and the register is read three cards across on a desk: the
 *  location mark is 24px, the actions trigger 32px, the team count is an 11px label in a 0.5rem pad, and
 *  the open control is sized by its own line. On a phone the same card is one column and the only way into
 *  a project, so a 20px target there is the difference between opening a project and opening the wrong one.
 *
 *  This is a silent failure mode: nothing renders differently, nothing throws, and jsdom has no layout to
 *  measure, so the floor is pinned here as text. `--touch-target` (44px, tokens.css) is the same floor the
 *  register's own rows, the toolbars and the drawer already state. */
const CSS = readFileSync(join(resolve(process.cwd()), 'app', 'styles', 'components', 'project-card.css'), 'utf-8');
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of one at-rule, matched by its exact prelude. */
function atRuleBody(css: string, prelude: string): string {
  const at = stripComments(css).indexOf(prelude);
  expect(at, `${prelude} is missing`).toBeGreaterThanOrEqual(0);
  return stripComments(css).slice(at, stripComments(css).indexOf('}', at));
}

describe('Project register card touch targets', () => {
  it('grows every control on a card to the shared floor for a coarse pointer', () => {
    const coarse = atRuleBody(CSS, '@media (pointer: coarse)');
    expect(coarse).toContain('[data-project-card]');
    expect(coarse).toMatch(/min-height:\s*var\(--touch-target\)/);
    expect(coarse).toMatch(/min-width:\s*var\(--touch-target\)/);
  });

  it('keeps the card quiet on a fine pointer, where the grid is read at its own density', () => {
    // The floor lives inside the coarse block and nowhere else: a `min-height` on the card's controls in
    // the base rules would grow every card on a desktop, which is the layout three columns were sized for.
    const base = stripComments(CSS).replace(atRuleBody(CSS, '@media (pointer: coarse)'), '');
    expect(base).not.toMatch(/min-(height|width):\s*var\(--touch-target\)/);
  });
});
