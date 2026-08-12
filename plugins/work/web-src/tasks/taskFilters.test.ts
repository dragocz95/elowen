import { describe, expect, it } from 'vitest';
import type { Task } from '../types';
import { ensurePluginUiRuntime } from '../../../../web/lib/pluginUi';

// The views resolve every component, hook and helper through window.ElowenUiRuntime at module
// scope — install the REAL runtime first (the same records the app hands a bundle), then import
// them, exactly as the host page does in the browser.
ensurePluginUiRuntime();
const { taskFilterCounts } = await import('./taskFilters');

describe('taskFilterCounts', () => {
  it('counts top-level tasks with effective epic status and a separate autopilot total', () => {
    const tasks = [
      { id: 'active', title: 'Active', status: 'in_progress', type: 'task', labels: [] },
      { id: 'open', title: 'Open', status: 'open', type: 'task', labels: [] },
      { id: 'blocked', title: 'Blocked', status: 'blocked', type: 'task', labels: [] },
      { id: 'closed', title: 'Closed', status: 'closed', type: 'task', labels: [] },
      { id: 'epic', title: 'Epic', status: 'open', type: 'epic', labels: [] },
      { id: 'phase', parent_id: 'epic', title: 'Phase', status: 'open', type: 'task', labels: [] },
    ] as Task[];

    expect(taskFilterCounts(tasks, [])).toEqual({
      in_progress: 1,
      open: 2,
      blocked: 1,
      closed: 1,
      autopilot: 1,
      all: 5,
    });
  });
});
