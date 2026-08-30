import { describe, it, expect } from 'vitest';
import { currentMonthBounds, trailingWeek } from '../../../modules/dashboard/metrics';

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

describe('trailingWeek', () => {
  it('keeps measured UTC days in seven fixed slots and fills omitted days', () => {
    const now = Date.UTC(2026, 7, 30, 12);
    const days = trailingWeek([
      { day: '2026-08-25', tokens: 2500, cost: 0.5 },
      { day: '2026-08-30', tokens: 9000, cost: 1.75 },
    ], now);

    expect(days).toHaveLength(7);
    expect(days.map((day) => day.day)).toEqual([
      '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30',
    ]);
    expect(days.map((day) => day.tokens)).toEqual([0, 2500, 0, 0, 0, 0, 9000]);
    expect(days[6]?.cost).toBe(1.75);
  });
});
