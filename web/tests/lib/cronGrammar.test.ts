import { describe, it, expect } from 'vitest';
import { isValidSchedule } from '../../lib/cronSchedule';
import { isValidSchedule as isValidScheduleDirect } from '../../lib/cron';

/** The web's two cron-schedule predicates are one file's views of the same grammar (`lib/cron.ts`'s
 *  parser, re-exported validation-only through `lib/cronSchedule.ts`). This characterization test pins
 *  the accepted/rejected corpus of BOTH views — unchanged from the pre-merge behaviour, as proof the
 *  merge altered nothing. Expected values mirror the plugin's authoritative `parseSchedule`
 *  (tests/contract/cronParity.test.ts pins that separately against the frozen shared corpus).
 *
 *  Both exports are COMPATIBILITY-ONLY now: the browser's next-run expansion was removed, so the new
 *  cronjob UI never parses a schedule itself — the plugin's `schedule-preview` route does, with the
 *  engine that will actually run it. These tests exist so the retained helper cannot silently change
 *  agreement under the still-released bundles that read it. */

const CASES: Array<[string, boolean]> = [
  // human-readable recurring forms
  ['every 15m', true],
  ['every 2h', true],
  ['every 1m', true],
  ['every 60m', true],
  ['every 999999999999m', true], // large intervals are accepted as-is
  ['Every 1H', true],            // case-insensitive unit
  ['every 0m', false],
  ['every 0h', false],
  ['every 30s', false],          // only m/h units exist
  ['daily 07:30', true],
  ['daily 00:00', true],
  ['daily 23:59', true],
  ['daily 7:5', false],          // the minute must be two digits
  ['daily 7:05', true],          // single-digit hour is allowed
  ['daily 24:00', false],
  ['daily 07:60', false],
  ['weekly sun 20:00', true],
  ['weekly fri 09:05', true],
  ['weekly MON 08:00', true],    // case-insensitive day name
  ['weekly sun 24:00', false],
  ['weekly xyz 10:00', false],
  ['weekly sun 10:00 extra', false],
  // cron expressions
  ['0 9 * * 1-5', true],
  ['*/15 * * * *', true],
  ['0 0 1 * *', true],
  ['0 0 29 2 *', true],
  ['0 0 * * sun', true],
  ['0 9 * jan-mar *', true],
  ['30 8,12,18 * * *', true],
  ['5/15 * * * *', true],        // bare value + step = "from here to the end"
  ['0 0 * * 7', true],           // Sunday as 7 folds onto 0
  ['0 9 * * SUN', true],         // case-insensitive name
  ['0 9 * * mon-fri', true],     // named range
  ['0 0 * * 1-7', true],         // range up to and including the wrap value
  ['0\t9 * * *', true],          // any whitespace separates fields
  ['* * * * *', true],
  ['0 9 * *', false],            // four fields
  ['0 9 * * *  *', false],       // six fields
  ['99 * * * *', false],
  ['0 24 * * *', false],
  ['0 9 * * 8', false],
  ['0 9 32 * *', false],
  ['0 9 * 13 *', false],
  ['1-3-5 * * * *', false],      // range with three bounds
  ['1,2, * * * *', false],       // trailing comma leaves an empty part
  ['*/0 * * * *', false],        // step must be at least 1
  ['60 * * * *', false],
  ['0 0 0 * *', false],          // day-of-month starts at 1
  // degenerate inputs
  ['', false],
  ['   ', false],
  ['nonsense', false],
];

describe('cron schedule grammar (characterization of the web copies)', () => {
  for (const [spec, expected] of CASES) {
    it(`accepts ${JSON.stringify(spec)} as ${expected}`, () => {
      expect(isValidSchedule(spec)).toBe(expected);
      expect(isValidScheduleDirect(spec)).toBe(expected);
    });
  }
});
