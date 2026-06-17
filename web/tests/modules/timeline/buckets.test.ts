import { describe, it, expect } from 'vitest';
import { bucketByHour } from '../../../modules/timeline/buckets';
import type { ActivityEvent } from '../../../lib/types';

const ev = (id: number, ts: string): ActivityEvent => ({ id, ts, type: 'task', target: 't', detail: 'open' });
const NOW = Date.parse('2026-06-17T12:30:00Z');

describe('bucketByHour', () => {
  it('returns 12 buckets oldest→newest', () => {
    const b = bucketByHour([], NOW);
    expect(b).toHaveLength(12);
    expect(b[11].count).toBe(0);
  });
  it('counts events into their hour bucket', () => {
    const b = bucketByHour([ev(1, '2026-06-17T12:05:00Z'), ev(2, '2026-06-17T12:50:00Z'), ev(3, '2026-06-17T11:10:00Z')], NOW);
    expect(b[11].count).toBe(2); // current hour (12:00)
    expect(b[10].count).toBe(1); // previous hour (11:00)
  });
  it('skips unparseable ts and out-of-range events', () => {
    const b = bucketByHour([ev(1, 'garbage'), ev(2, '2020-01-01T00:00:00Z')], NOW);
    expect(b.reduce((s, x) => s + x.count, 0)).toBe(0);
  });
});
