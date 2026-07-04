import { describe, it, expect } from 'vitest';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../plugins/cronjob/index.mjs');
const mod = await import(pluginPath) as {
  parseSchedule(spec: string): { kind: string; day?: number; hour?: number; minute?: number; ms?: number } | null;
  inHours(hours: string | undefined, now: number): boolean;
  isDue(job: Record<string, unknown>, now: number): boolean;
  isQuietReply(reply: unknown): boolean;
  cronFooter(idle: unknown): string;
  runCheck(command: string, logger?: { warn?: (m: string) => void }): Promise<{ skip: boolean; output?: string; reason?: string }>;
};

// Mon 2026-07-06 10:00 local
const MON_10 = new Date(2026, 6, 6, 10, 0, 0).getTime();
// Sun 2026-07-05 20:30 local
const SUN_2030 = new Date(2026, 6, 5, 20, 30, 0).getTime();

describe('cronjob schedule extensions', () => {
  it('parses weekly specs', () => {
    expect(mod.parseSchedule('weekly sun 20:00')).toEqual({ kind: 'weekly', day: 0, hour: 20, minute: 0 });
    expect(mod.parseSchedule('weekly fri 07:30')).toEqual({ kind: 'weekly', day: 5, hour: 7, minute: 30 });
    expect(mod.parseSchedule('weekly xyz 07:30')).toBeNull();
  });

  it('weekly jobs fire only on their day, once after the time', () => {
    const job = { schedule: 'weekly sun 20:00' };
    expect(mod.isDue(job, SUN_2030)).toBe(true);
    expect(mod.isDue({ ...job, lastRun: new Date(SUN_2030 - 60_000).toISOString() }, SUN_2030)).toBe(false); // already ran after 20:00
    expect(mod.isDue(job, MON_10)).toBe(false); // wrong day
  });

  it('the hours window gates interval jobs (with overnight support)', () => {
    expect(mod.inHours('5-21', new Date(2026, 6, 6, 10).getTime())).toBe(true);
    expect(mod.inHours('5-21', new Date(2026, 6, 6, 23).getTime())).toBe(false);
    expect(mod.inHours('22-5', new Date(2026, 6, 6, 23).getTime())).toBe(true);
    expect(mod.inHours(undefined, MON_10)).toBe(true);
    const job = { schedule: 'every 15m', hours: '5-21' };
    expect(mod.isDue(job, new Date(2026, 6, 6, 23).getTime())).toBe(false);
    expect(mod.isDue(job, MON_10)).toBe(true);
  });

  it('disabled jobs never fire', () => {
    expect(mod.isDue({ schedule: 'every 5m', enabled: false }, MON_10)).toBe(false);
  });

  it('quiet replies (Hermes [SILENT] + NOTHING_TO_REPORT, wrapped or not) are recognized', () => {
    expect(mod.isQuietReply('NOTHING_TO_REPORT')).toBe(true);
    expect(mod.isQuietReply('[SILENT]')).toBe(true);
    expect(mod.isQuietReply('`[SILENT]`')).toBe(true);       // models love wrapping markers in backticks
    expect(mod.isQuietReply('**NOTHING_TO_REPORT**')).toBe(true);
    expect(mod.isQuietReply('  nothing_to_report  ')).toBe(true);
    expect(mod.isQuietReply('New bookings: 2')).toBe(false);
    expect(mod.isQuietReply('[SILENT] but also this')).toBe(false); // marker + content = real content
    expect(mod.isQuietReply('')).toBe(false);
  });

  it('cronFooter renders model · context% from the idle event (empty when no data)', () => {
    expect(mod.cronFooter({ model: 'anthropic/claude-sonnet-5', usage: { percent: 41.6 } })).toBe('-# claude-sonnet-5 · 42 %');
    expect(mod.cronFooter({ model: 'gpt-5' })).toBe('-# gpt-5');                       // percent missing → model only
    expect(mod.cronFooter({ usage: { percent: 10 } })).toBe('-# 10 %');                // model missing → percent only
    expect(mod.cronFooter(null)).toBe('');                                             // no idle event → no footer
    expect(mod.cronFooter({ usage: { percent: null } })).toBe('');                     // no usable numbers
  });

  describe('runCheck (the cheap guard gate)', () => {
    it('skips the brain turn when the guard prints nothing', async () => {
      expect(await mod.runCheck('true')).toEqual({ skip: true, reason: 'nothing new' });
      expect(await mod.runCheck('echo -n ""')).toEqual({ skip: true, reason: 'nothing new' });
      expect(await mod.runCheck('printf "   \\n  "')).toEqual({ skip: true, reason: 'nothing new' }); // whitespace-only = nothing
    });

    it('runs the brain turn (skip:false) and hands over trimmed output when the guard prints', async () => {
      const res = await mod.runCheck('echo "new booking: Patricie 14:00"');
      expect(res.skip).toBe(false);
      expect(res.output).toBe('new booking: Patricie 14:00');
    });

    it('skips (never runs the brain) when the guard exits non-zero — a broken signal is not new work', async () => {
      const warns: string[] = [];
      const res = await mod.runCheck('echo partial; exit 1', { warn: (m) => warns.push(m) });
      expect(res.skip).toBe(true);
      expect(res.reason).toMatch(/check failed/);
      expect(warns.length).toBe(1); // the failure is logged, not swallowed silently
    });
  });
});
