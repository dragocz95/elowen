import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';

/** The digest's transcript sample reads brain_messages — the largest table in the database — so its
 *  query plan is pinned the same way the usage-origin view's is: `db.prepare` is intercepted to explain
 *  the REAL SQL the store runs (a copy kept in the test would keep passing after a rewrite). The read
 *  must go through the per-session index, never a full-table scan on the daemon's synchronous loop. */
describe('userMessagesBetween stays on the session index', () => {
  it('searches via idx_brain_messages_session', () => {
    const db = openDb(':memory:');
    const plans: string[] = [];
    const original = db.prepare.bind(db);
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      const stmt = original(sql);
      if (!/brain_messages/i.test(sql) || !/^\s*SELECT/i.test(sql)) return stmt;
      const explain = original(`EXPLAIN QUERY PLAN ${sql}`);
      return new Proxy(stmt, {
        get(target, prop, receiver) {
          if (prop !== 'all') return Reflect.get(target, prop, receiver);
          return (...params: unknown[]) => {
            plans.push(...(explain.all(...params) as { detail: string }[]).map((r) => r.detail));
            return (target.all as (...a: unknown[]) => unknown)(...params);
          };
        },
      });
    }) as typeof db.prepare;

    const store = new BrainStore(db);
    store.userMessagesBetween('brain-1-abc', '2026-08-30 00:00:00', '2026-08-31 00:00:00', 10);
    const joined = plans.join('\n');
    expect(plans.length).toBeGreaterThan(0);
    expect(joined).toMatch(/idx_brain_messages_session/);
    expect(joined).not.toMatch(/SCAN brain_messages/);
  });
});
