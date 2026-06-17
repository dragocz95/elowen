import { describe, it, expect } from 'vitest';
import { groupByStatus } from '../../../modules/kanban/groupByStatus';
import type { Task } from '../../../lib/types';

const t = (id: string, status: Task['status']): Task => ({ id, title: id, status });

describe('groupByStatus', () => {
  it('buckets tasks by status with every status key present', () => {
    const g = groupByStatus([t('a', 'open'), t('b', 'open'), t('c', 'blocked')]);
    expect(g.open.map((x) => x.id)).toEqual(['a', 'b']);
    expect(g.blocked.map((x) => x.id)).toEqual(['c']);
    expect(g.in_progress).toEqual([]);
    expect(g.closed).toEqual([]);
    expect(g.cancelled).toEqual([]);
  });
  it('returns all-empty buckets for no tasks', () => {
    const g = groupByStatus([]);
    expect(g).toEqual({ open: [], in_progress: [], blocked: [], closed: [], cancelled: [] });
  });
});
