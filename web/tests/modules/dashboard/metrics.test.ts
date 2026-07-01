import { describe, it, expect } from 'vitest';
import { currentMonthBounds } from '../../../modules/dashboard/metrics';

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
