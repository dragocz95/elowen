import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { isValidSchedule as webValid } from '../../web/lib/cronSchedule';
import { isValidSchedule as webRunValid } from '../../web/lib/cron';

// The cron/schedule grammar is hand-mirrored in THREE implementations that cannot import one another:
// the cronjob plugin's parseSchedule (the authority — it also validates the /plugins/cronjob/jobs API
// writes), web/lib/cronSchedule.ts (web validation, exposed to the plugin bundle via the runtime utils)
// and web/lib/cron.ts (the same grammar, kept in lockstep with the first).
//
// The plugin now lives in the registry, so no single test can hold all three side by side any more.
// Both sides therefore pin themselves to the same corpus — and to the SAME FILE, not two copies with a
// promise: it ships inside elowen-plugin-shared, which the daemon depends on and every registry plugin
// resolves at runtime. Widening the grammar means publishing a new version of that package, so the two
// sides cannot drift apart while both stay green.
//
// The web's next-run expansion was removed: future occurrences come from the plugin's server
// projection (`nextOccurrence`), which reads the scheduler's own timezone/active-hours/catch-up rules.
// Only the COMPATIBILITY-ONLY validity view remains on the web side, and that is what this parity
// contract pins.
const grammar = JSON.parse(
  readFileSync(createRequire(import.meta.url).resolve('elowen-plugin-shared/cronGrammar'), 'utf-8'),
) as { accepts: Record<string, boolean> };

describe('cron schedule grammar parity (web-validate ⋅ frozen contract)', () => {
  // A corpus that quietly shrank would pass while proving nothing, so state its shape up front.
  it('covers both accepted and rejected forms', () => {
    const values = Object.values(grammar.accepts);
    expect(values.filter(Boolean).length).toBeGreaterThan(10);
    expect(values.filter((v) => !v).length).toBeGreaterThan(10);
  });

  for (const [spec, expected] of Object.entries(grammar.accepts)) {
    it(`agrees on ${JSON.stringify(spec)}`, () => {
      expect(webValid(spec)).toBe(expected);
      expect(webRunValid(spec)).toBe(expected);
    });
  }
});
