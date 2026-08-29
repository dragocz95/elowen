import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  join(import.meta.dirname, '..', '..', 'app', 'styles', 'components', 'spatial-deck.css'),
  'utf8',
);

/** The deck's section rail scrolls horizontally with its scrollbar hidden — which is right on a phone,
 *  where a native bar over a 6.75rem icon strip is louder than the strip. What it cost was discoverability:
 *  at 390x844 the rail needed ~648px and had ~354px, so three of the six settings sections sat past the
 *  right edge with nothing on screen suggesting they existed. A user could not tell there was more.
 *
 *  The affordance is a mask that fades both edges into the page, scoped to the container width where the
 *  overflow is arithmetic rather than a guess. It is CSS with no JavaScript to exercise, so this asserts
 *  the two halves that make it work — the fade AND the fact that the scrollbar is still hidden, since
 *  putting the bar back would be the other way to "fix" this and would undo the reason it was hidden. */
describe('section rail scroll affordance', () => {
  it('fades the rail edges wherever it scrolls with a hidden scrollbar', () => {
    expect(css).toMatch(/\.spatial-section-rail\b[^}]*scrollbar-width:\s*none/);

    const phoneBlock = css.slice(css.indexOf('@container workspace-shell (width < 38.75rem)'));
    expect(phoneBlock).toMatch(/\.spatial-section-rail\s*\{[^}]*mask-image:\s*linear-gradient/);
  });

  it('keeps the fade out of the widths where the rail fits', () => {
    // A permanent fade would dim the first and last section on a desktop deck that has room for all of
    // them, which reads as a rendering bug rather than as "there is more this way".
    const beforePhoneBlock = css.slice(0, css.indexOf('@container workspace-shell (width < 38.75rem)'));
    expect(beforePhoneBlock).not.toContain('mask-image');
  });
});
