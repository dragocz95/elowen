import { describe, it, expect } from 'vitest';
import { openDb } from '../../../src/store/db.js';
import { TaskUsageStore } from '../../../src/store/taskUsageStore.js';
import { EventBus } from '../../../src/api/sse.js';
import { UsageRecorder } from '../../../src/integrations/usage/recorder.js';
import type { TokenUsage } from '../../../src/integrations/usage/types.js';

const fakeUsage: TokenUsage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18, costUsd: 0.3 };
const task = (over: Partial<{ id: string; project_id: number; labels: string[]; parent_id: string | null }> = {}) =>
  ({ id: 't1', project_id: 1, parent_id: null, created_at: '', labels: ['exec:sonnet'], ...over });

function setup(read: () => TokenUsage | null = () => fakeUsage) {
  const usage = new TaskUsageStore(openDb(':memory:'));
  const bus = new EventBus();
  const tasks = { get: (_id: string) => task(), list: () => [task()] };
  new UsageRecorder({ usage, tasks: tasks as never, pathFor: () => '/p', fallback: { program: 'claude-code', model: 'sonnet' }, read }).subscribe(bus);
  return { usage, bus };
}

describe('UsageRecorder', () => {
  it('records a settled task on a closed event', () => {
    const { usage, bus } = setup();
    bus.publish({ type: 'task', taskId: 't1', status: 'closed' });
    expect(usage.aggregateByExec()).toEqual([{ exec: 'sonnet', usage: fakeUsage }]);
  });

  it('also records on cancelled', () => {
    const { usage, bus } = setup();
    bus.publish({ type: 'task', taskId: 't1', status: 'cancelled' });
    expect(usage.aggregateByExec()).toHaveLength(1);
  });

  it('ignores non-terminal task events', () => {
    const { usage, bus } = setup();
    bus.publish({ type: 'task', taskId: 't1', status: 'open' });
    bus.publish({ type: 'task', taskId: 't1', status: 'blocked' });
    expect(usage.aggregateByExec()).toEqual([]);
  });

  it('skips a task with no usage found (reader returned null)', () => {
    const { usage, bus } = setup(() => null);
    bus.publish({ type: 'task', taskId: 't1', status: 'closed' });
    expect(usage.aggregateByExec()).toEqual([]);
  });

  it('never lets a reader error abort the bus broadcast', () => {
    const usage = new TaskUsageStore(openDb(':memory:'));
    const bus = new EventBus();
    const tasks = { get: () => task(), list: () => [task()] };
    new UsageRecorder({ usage, tasks: tasks as never, pathFor: () => '/p', fallback: { program: 'claude-code', model: 'sonnet' }, read: () => { throw new Error('boom'); } }).subscribe(bus);
    let reachedOther = false;
    bus.subscribe(() => { reachedOther = true; });
    expect(() => bus.publish({ type: 'task', taskId: 't1', status: 'closed' })).not.toThrow();
    expect(reachedOther).toBe(true);
    expect(usage.aggregateByExec()).toEqual([]);
  });
});
