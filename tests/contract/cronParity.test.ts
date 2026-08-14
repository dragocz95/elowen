import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { isValidSchedule as webValid } from '../../web/lib/cronSchedule';
import { isValidSchedule as webRunValid, nextCronRun } from '../../web/lib/cron';
import type { CronJob } from '../../web/lib/types';

// The cron/schedule grammar is hand-mirrored in THREE implementations that cannot import one another:
// the cronjob plugin's parseSchedule (the authority — it also validates the /plugins/cronjob/jobs API
// writes), web/lib/cronSchedule.ts (web validation, exposed to the plugin bundle via the runtime utils)
// and web/lib/cron.ts (the dashboard's next-run computation).
//
// The plugin now lives in the registry, so no single test can hold all three side by side any more.
// Instead both sides pin themselves to the same frozen corpus: this file checks the two WEB copies, and
// the registry checks the plugin against a byte-identical fixture. A drift like web/lib/cron.ts silently
// dropping the cron-expression branch — a valid job shown as "never fires" — still fails here.
const grammar = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'cronGrammar.json'), 'utf-8'),
) as { accepts: Record<string, boolean> };

describe('cron schedule grammar parity (web-validate ⋅ web-nextrun ⋅ frozen contract)', () => {
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

  it('nextCronRun computes a real future timestamp for a cron expression (regression: was null)', () => {
    const now = Date.parse('2026-07-20T10:00:00Z');
    const job = { schedule: '0 9 * * 1-5', enabled: true } as unknown as CronJob;
    const next = nextCronRun(job, now);
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(now);
  });
});
