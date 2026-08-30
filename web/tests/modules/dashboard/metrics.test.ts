import { describe, it, expect } from 'vitest';
import { currentMonthBounds, trailingDays } from '../../../modules/dashboard/metrics';

describe('currentMonthBounds', () => {
  it('starts at local midnight on the 1st of the current month, open-ended upper bound', () => {
    const now = new Date('2026-06-23T14:30:00').getTime();
    const { fromMs, toMs } = currentMonthBounds(now);
    expect(fromMs).toBe(new Date('2026-06-01T00:00:00').getTime());
    expect(toMs).toBe(Infinity);
  });

  it('rolls over correctly at the start of a month', () => {
    const now = new Date('2026-01-01T00:00:01').getTime();
    const { fromMs } = currentMonthBounds(now);
    expect(fromMs).toBe(new Date('2026-01-01T00:00:00').getTime());
  });
});

describe('trailingDays', () => {
  it('keeps measured UTC days in fixed slots and fills omitted days', () => {
    const now = Date.UTC(2026, 7, 30, 12);
    const days = trailingDays([
      { day: '2026-08-25', tokens: 2500, input: 2000, output: 100, cacheRead: 300, cacheWrite: 100, cost: 0.5 },
      { day: '2026-08-30', tokens: 9000, input: 6000, output: 1000, cacheRead: 1500, cacheWrite: 500, cost: 1.75 },
    ], now, 7);

    expect(days).toHaveLength(7);
    expect(days.map((day) => day.day)).toEqual([
      '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30',
    ]);
    expect(days.map((day) => day.tokens)).toEqual([0, 2500, 0, 0, 0, 0, 9000]);
    expect(days[6]?.cost).toBe(1.75);
    // A measured day keeps its component fields untouched for the chart's breakdown readout.
    expect(days[1]).toEqual({ day: '2026-08-25', tokens: 2500, input: 2000, output: 100, cacheRead: 300, cacheWrite: 100, cost: 0.5 });
  });

  it('spans thirty slots ending today for the metrics chart, filler days unpriced with zero components', () => {
    const now = Date.UTC(2026, 7, 30, 12);
    const days = trailingDays([], now, 30);

    expect(days).toHaveLength(30);
    expect(days[29]?.day).toBe('2026-08-30');
    // An absent day states zero measured tokens and an UNPRICED cost — null, never a fabricated $0.
    expect(days[0]).toEqual({ day: '2026-08-01', tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null });
  });
});
