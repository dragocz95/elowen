import { describe, expect, it, vi } from 'vitest';
import { runnerReloadActivityCount } from '../../src/subagent/activity.js';

describe('runner reload activity', () => {
  it('includes runner-local core and plugin work in addition to dispatched channels', async () => {
    const reloadOwnedWorkCount = vi.fn(async () => 4);

    await expect(runnerReloadActivityCount(2, { reloadOwnedWorkCount })).resolves.toBe(6);
    expect(reloadOwnedWorkCount).toHaveBeenCalledOnce();
  });

  it('reports dispatched channels while the runner brain is still booting', async () => {
    await expect(runnerReloadActivityCount(2, undefined)).resolves.toBe(2);
  });
});
