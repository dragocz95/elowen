import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { UsageOriginStore } from '../../src/store/usageOriginStore.js';

/** Query plans of every statement the admin origin view executes, as SQLite itself reports them.
 *  `db.prepare` is intercepted so the test observes the REAL SQL of `topOrigins`, not a copy of it kept
 *  in the test — a copy would keep passing after the implementation was rewritten, which is the exact
 *  regression this guards against. */
function plansOf(run: (store: UsageOriginStore) => void): string[] {
  const db = openDb(':memory:');
  const store = new UsageOriginStore(db);
  const plans: string[] = [];
  const original = db.prepare.bind(db);
  (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
    const stmt = original(sql);
    if (!/^\s*SELECT/i.test(sql)) return stmt;
    // Explain at CALL time, with the parameters the store actually binds — a plan needs its bindings.
    const explain = original(`EXPLAIN QUERY PLAN ${sql}`);
    return new Proxy(stmt, {
      get(target, prop, receiver) {
        if (prop !== 'all' && prop !== 'get') return Reflect.get(target, prop, receiver);
        return (...params: unknown[]) => {
          plans.push(...(explain.all(...params) as { detail: string }[]).map((r) => r.detail));
          return (target[prop] as (...a: unknown[]) => unknown)(...params);
        };
      },
    });
  }) as typeof db.prepare;
  run(store);
  return plans;
}

describe('the admin origin view never scans the message store', () => {
  it.each(['pair', 'user', 'origin'] as const)('reads usage_by_origin alone when grouping by %s', (group) => {
    const plans = plansOf((store) => { store.topOrigins({ group, fromIso: '2026-08-01', toIso: '2026-08-31', limit: 20 }); });
    expect(plans.length).toBeGreaterThan(0);
    const joined = plans.join('\n');
    // The whole point of the write-time rollup. brain_messages is the largest table in the database and
    // /usage/by-model already pays a full scan of it with per-row json_extract (~1.2 s cold, ON the
    // daemon's synchronous event loop). A future "just add the model to the breakdown" would reach for a
    // join back to it and quietly reintroduce that cost for every admin poll.
    expect(joined).not.toMatch(/brain_messages/);
    expect(joined).not.toMatch(/brain_sessions/);
    expect(joined).toMatch(/usage_by_origin/);
  });

  it('answers the tracking window without touching the message store either', () => {
    const plans = plansOf((store) => { store.trackingSince(); });
    expect(plans.join('\n')).not.toMatch(/brain_messages/);
  });
});
