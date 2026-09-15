import { describe, it, expect } from 'vitest';
import { isValidSchedule } from '../../lib/cron';

/** The browser's next-run expansion was removed: every future occurrence now comes from the
 *  scheduler's own server projection (`nextOccurrence` on the job the cronjob plugin serves), which
 *  reads the configured timezone, active hours and catch-up rules instead of a hand-synced browser
 *  copy of the grammar that quietly disagreed. What the web module still does — and what these tests
 *  pin — is the COMPATIBILITY-ONLY validity view (`isValidSchedule`) the released API 12 bundles
 *  reach through `window.ElowenUiRuntime.utils.isValidSchedule`.
 *
 *  The accepted/rejected grammar itself is characterized in detail by `cronGrammar.test.ts` (the
 *  frozen shared corpus) and pinned to the plugin's copy by `tests/contract/cronParity.test.ts`; both
 *  import this function too. This file only holds what the removed code used to test on its own. */

describe('isValidSchedule (compatibility export)', () => {
  it('stays exported and reachable from the lib surface the runtime utils import', () => {
    expect(typeof isValidSchedule).toBe('function');
    expect(isValidSchedule('every 15m')).toBe(true);
    expect(isValidSchedule('every 30s')).toBe(false);
  });

  it('is the same gateway cronSchedule re-exports to the settings UI', async () => {
    const mod = await import('../../lib/cronSchedule');
    expect(mod.isValidSchedule('daily 07:30')).toBe(true);
    expect(mod.isValidSchedule('nonsense')).toBe(false);
  });
});
