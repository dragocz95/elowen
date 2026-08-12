import { describe, it, expect } from 'vitest';
import { ensurePluginUiRuntime } from '../../../../web/lib/pluginUi';

// The views resolve every component, hook and helper through window.ElowenUiRuntime at module
// scope — install the REAL runtime first (the same records the app hands a bundle), then import
// them, exactly as the host page does in the browser.
ensurePluginUiRuntime();
const { groupByStatus } = await import('./groupByStatus');
import type { Task } from '../types';

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
