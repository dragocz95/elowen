import { describe, it, expect } from 'vitest';
import {
  NAV_COLUMN_MIN_WIDTH,
  NAV_FULL_MIN_WIDTH,
  PHONE_MAX_WIDTH,
  TABLET_MAX_WIDTH,
} from '../../lib/breakpoints';

/** The ladder is consumed by hooks, by the shell and — mirrored — by the stylesheets. A retune that
 *  breaks its shape produces a width that two consumers classify differently, which is the whole class
 *  of bug this module was extracted to make impossible. */
describe('breakpoint ladder', () => {
  it('is strictly ordered, so every width falls in exactly one band', () => {
    expect(PHONE_MAX_WIDTH).toBeLessThan(TABLET_MAX_WIDTH);
    expect(TABLET_MAX_WIDTH).toBeLessThan(NAV_FULL_MIN_WIDTH);
  });

  // A "max" breakpoint is inclusive and a "min" is exclusive-below, so the two must be adjacent
  // integers. A gap would leave a width that is neither a phone nor roomy enough for a nav column;
  // an overlap would make one width both.
  it('leaves no width between the phone band and the nav-column threshold', () => {
    expect(NAV_COLUMN_MIN_WIDTH).toBe(PHONE_MAX_WIDTH + 1);
  });

  it('aligns the device bands with the utility framework, so JS and CSS agree at the boundary', () => {
    expect(PHONE_MAX_WIDTH).toBe(767);   // md (48rem) − 1px
    expect(TABLET_MAX_WIDTH).toBe(1023); // lg (64rem) − 1px
    expect(NAV_FULL_MIN_WIDTH).toBe(1280); // xl (80rem)
  });
});
