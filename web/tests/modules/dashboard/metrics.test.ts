import { describe, it, expect } from 'vitest';
import { deriveDashboardMetrics, currentMonthBounds } from '../../../modules/dashboard/metrics';
import type { Task, Mission } from '../../../lib/types';

const task = (id: string, status: Task['status']): Task => ({ id, title: id, status });
const mission = (id: string, state: Mission['state']): Mission => ({ id, epic_id: 'e', autonomy: 'L0', max_sessions: 1, state });

describe('deriveDashboardMetrics', () => {
  it('returns all zeros for empty/undefined inputs', () => {
    expect(deriveDashboardMetrics(undefined, undefined, undefined)).toEqual({
      open: 0, inProgress: 0, blocked: 0, liveSessions: 0, activeMissions: 0,
    });
  });
  it('counts tasks per rendered status and live sessions', () => {
    const m = deriveDashboardMetrics(
      [task('a', 'open'), task('b', 'open'), task('c', 'in_progress'), task('d', 'blocked'), task('e', 'closed'), task('f', 'cancelled')],
      ['s1', 's2'],
      [],
    );
    expect(m).toEqual({ open: 2, inProgress: 1, blocked: 1, liveSessions: 2, activeMissions: 0 });
  });
  it('counts only non-disengaged missions as active', () => {
    const m = deriveDashboardMetrics([], [], [mission('m1', 'active'), mission('m2', 'paused'), mission('m3', 'disengaged')]);
    expect(m.activeMissions).toBe(2);
  });
});

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
