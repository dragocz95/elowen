import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '../../src/store/db.js';
import { TaskUsageStore } from '../../src/store/taskUsageStore.js';
import type { TokenUsage } from '../../src/integrations/usage/types.js';

const u = (input: number, output: number, cacheRead: number, cacheWrite: number, costUsd: number | null): TokenUsage =>
  ({ input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite, costUsd });

let store: TaskUsageStore;
let db: Db;
beforeEach(() => { db = openDb(':memory:'); store = new TaskUsageStore(db); });

/** Backdate a recorded row's captured_at directly (record() always stamps "now" — tests that need a
 *  specific window must move the clock back in the DB after the fact). */
const backdate = (taskId: string, iso: string): void => {
  db.prepare('UPDATE task_usage SET captured_at = datetime(?) WHERE task_id = ?').run(iso, taskId);
};

describe('TaskUsageStore', () => {
  it('aggregates recorded tasks per exec spec', () => {
    store.record('t1', 1, 'sonnet', u(100, 50, 10, 5, 0.5));
    store.record('t2', 1, 'sonnet', u(200, 60, 20, 0, 1.0));
    store.record('t3', 1, 'opus', u(300, 90, 0, 0, null));

    const rows = store.aggregateByExec();
    const sonnet = rows.find((r) => r.exec === 'sonnet')!;
    expect(sonnet.usage).toEqual(u(300, 110, 30, 5, 1.5));
    const opus = rows.find((r) => r.exec === 'opus')!;
    expect(opus.usage.total).toBe(390);
    expect(opus.usage.costUsd).toBeNull();
  });

  it('reports a null cost only when no row in the bucket has a cost', () => {
    store.record('a', 1, 'mix', u(10, 0, 0, 0, null));
    store.record('b', 1, 'mix', u(10, 0, 0, 0, 2));
    expect(store.aggregateByExec().find((r) => r.exec === 'mix')!.usage.costUsd).toBe(2);
  });

  it('upserts on the same task id (re-snapshot replaces, never doubles)', () => {
    store.record('t1', 1, 'sonnet', u(100, 0, 0, 0, 1));
    store.record('t1', 1, 'sonnet', u(250, 0, 0, 0, 2)); // same task settled again with final numbers
    const rows = store.aggregateByExec();
    expect(rows).toHaveLength(1);
    expect(rows[0].usage.total).toBe(250);
    expect(rows[0].usage.costUsd).toBe(2);
  });

  it('scopes the aggregate to the given project ids', () => {
    store.record('t1', 1, 'sonnet', u(100, 0, 0, 0, null));
    store.record('t2', 2, 'sonnet', u(900, 0, 0, 0, null));
    expect(store.aggregateByExec([1]).find((r) => r.exec === 'sonnet')!.usage.total).toBe(100);
    expect(store.aggregateByExec([1, 2]).find((r) => r.exec === 'sonnet')!.usage.total).toBe(1000);
    expect(store.aggregateByExec([])).toEqual([]); // no accessible projects → nothing
  });

  it('scopes the aggregate to a captured_at window', () => {
    store.record('old', 1, 'sonnet', u(100, 0, 0, 0, null));
    backdate('old', '2020-01-15 00:00:00');
    store.record('recent', 1, 'sonnet', u(50, 0, 0, 0, null));
    backdate('recent', '2026-06-15 00:00:00');
    const rows = store.aggregateByExec(undefined, { fromIso: '2026-06-01T00:00:00.000Z', toIso: '2026-06-30T23:59:59.999Z' });
    expect(rows.find((r) => r.exec === 'sonnet')!.usage.total).toBe(50);
  });

  it('combines a captured_at window with projectIds scoping', () => {
    store.record('t1', 1, 'sonnet', u(100, 0, 0, 0, null));
    backdate('t1', '2026-06-15 00:00:00');
    store.record('t2', 2, 'sonnet', u(900, 0, 0, 0, null));
    backdate('t2', '2026-06-15 00:00:00');
    const rows = store.aggregateByExec([1], { fromIso: '2026-06-01T00:00:00.000Z' });
    expect(rows.find((r) => r.exec === 'sonnet')!.usage.total).toBe(100);
  });

  it('an absent window reproduces the unfiltered totals (regression guard)', () => {
    store.record('old', 1, 'sonnet', u(100, 0, 0, 0, null));
    backdate('old', '2020-01-15 00:00:00');
    store.record('recent', 1, 'sonnet', u(50, 0, 0, 0, null));
    expect(store.aggregateByExec().find((r) => r.exec === 'sonnet')!.usage.total).toBe(150);
  });

  it('deleteAll empties the table and returns the row count', () => {
    store.record('t1', 1, 'sonnet', u(1, 0, 0, 0, null));
    store.record('t2', 1, 'opus', u(1, 0, 0, 0, null));
    expect(store.deleteAll()).toBe(2);
    expect(store.aggregateByExec()).toEqual([]);
  });
});
