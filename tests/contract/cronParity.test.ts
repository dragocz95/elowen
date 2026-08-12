import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidSchedule as webValid } from '../../web/lib/cronSchedule';
import { isValidSchedule as webRunValid, nextCronRun } from '../../web/lib/cron';
import type { CronJob } from '../../web/lib/types';

// The cron/schedule grammar is hand-mirrored in THREE places because the standalone web bundle cannot
// import the untyped `.mjs` plugin: the plugin's parseSchedule (the authority — it also validates the
// /plugins/cronjob/jobs API writes), web/lib/cronSchedule.ts (web validation, exposed to the plugin
// bundle via the runtime utils) and web/lib/cron.ts (the dashboard's next-run computation). This test
// pins them in lockstep — a drift like web/lib/cron.ts silently dropping the cron-expression branch (a
// valid job shown as "never fires") fails here instead of shipping wrong data.
const pluginPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../plugins/cronjob/index.mjs');
const plugin = await import(pluginPath) as { parseSchedule(spec: string): { kind: string } | null };

const CORPUS: string[] = [
  // human-readable recurring forms
  'every 15m', 'every 2h', 'every 1m', 'daily 07:30', 'weekly sun 20:00', 'weekly fri 09:05',
  // cron expressions (the branch web/lib/cron.ts used to drop)
  '0 9 * * 1-5', '*/15 * * * *', '0 0 1 * *', '0 0 29 2 *', '0 0 * * sun', '0 9 * jan-mar *',
  '30 8,12,18 * * *', '5/15 * * * *',
  // invalid — every copy must reject these identically
  'every 0m', 'nonsense', '0 9 * *', '0 9 * * *  *', '99 * * * *', '0 24 * * *', '0 9 * * 8',
  '0 9 32 * *', '0 9 * 13 *', '1-3-5 * * * *', 'daily 24:00', 'weekly xyz 10:00', '',
];

describe('cron schedule grammar parity (plugin ⋅ web-validate ⋅ web-nextrun)', () => {
  for (const spec of CORPUS) {
    it(`agrees on ${JSON.stringify(spec)}`, () => {
      const expected = plugin.parseSchedule(spec) !== null; // the authoritative parser
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
