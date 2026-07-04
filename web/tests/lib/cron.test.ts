import { describe, it, expect } from 'vitest';
import { nextCronRun } from '../../lib/cron';
import type { CronJob } from '../../lib/types';

/** Minimal cron job — only the fields nextCronRun reads matter; the rest satisfy the type. */
const job = (over: Partial<CronJob>): CronJob => ({ id: 'j', name: 'test', schedule: '', prompt: 'p', ...over });

describe('nextCronRun', () => {
  it('interval: next fire is lastRun + interval', () => {
    const now = new Date(2026, 6, 4, 12, 0, 0).getTime();
    const lastRun = new Date(now - 5 * 60_000).toISOString(); // 5 min ago
    expect(nextCronRun(job({ schedule: 'every 15m', lastRun }), now)).toBe(now + 10 * 60_000);
  });

  it('interval: a never-run or overdue job resolves to now (fires next tick)', () => {
    const now = new Date(2026, 6, 4, 12, 0, 0).getTime();
    expect(nextCronRun(job({ schedule: 'every 15m' }), now)).toBe(now); // never run
    const stale = new Date(now - 3 * 3_600_000).toISOString();
    expect(nextCronRun(job({ schedule: 'every 2h', lastRun: stale }), now)).toBe(now); // 3h > 2h → overdue
  });

  it('daily: today at HH:MM when still ahead, else tomorrow', () => {
    const before = new Date(2026, 6, 4, 6, 0, 0).getTime();
    expect(nextCronRun(job({ schedule: 'daily 07:30' }), before)).toBe(new Date(2026, 6, 4, 7, 30, 0).getTime());
    const after = new Date(2026, 6, 4, 8, 0, 0).getTime();
    expect(nextCronRun(job({ schedule: 'daily 07:30' }), after)).toBe(new Date(2026, 6, 5, 7, 30, 0).getTime());
  });

  it('weekly: next occurrence of the weekday at HH:MM, in the coming 7 days', () => {
    const now = new Date(2026, 6, 4, 12, 0, 0).getTime();
    const next = nextCronRun(job({ schedule: 'weekly sun 20:00' }), now)!;
    const d = new Date(next);
    expect(d.getDay()).toBe(0); // Sunday
    expect(d.getHours()).toBe(20);
    expect(d.getMinutes()).toBe(0);
    expect(next).toBeGreaterThan(now);
    expect(next - now).toBeLessThanOrEqual(8 * 24 * 3_600_000);
  });

  it('one-shot: returns runAt in the future, now when overdue, null once run', () => {
    const now = new Date(2026, 6, 4, 12, 0, 0).getTime();
    const future = new Date(now + 30 * 60_000).toISOString();
    expect(nextCronRun(job({ schedule: '', runAt: future }), now)).toBe(Date.parse(future));
    const past = new Date(now - 30 * 60_000).toISOString();
    expect(nextCronRun(job({ schedule: '', runAt: past }), now)).toBe(now); // overdue → imminent
    expect(nextCronRun(job({ schedule: '', runAt: future, lastRun: new Date(now).toISOString() }), now)).toBeNull(); // spent
  });

  it('returns null for a disabled job or an unparseable schedule', () => {
    const now = Date.now();
    expect(nextCronRun(job({ schedule: 'every 15m', enabled: false }), now)).toBeNull();
    expect(nextCronRun(job({ schedule: 'gibberish' }), now)).toBeNull();
    expect(nextCronRun(job({ schedule: 'every 30s' }), now)).toBeNull(); // sub-minute is invalid
  });
});
