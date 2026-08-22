import { describe, it, expect } from 'vitest';
import { openWorkDb } from '../helpers/workDb.js';
import { BrainStore } from '../../src/store/brainStore.js';

/** Query plans of every statement `descendantUsage` executes, as SQLite itself reports them. `db.prepare`
 *  is intercepted so the test observes the REAL SQL, not a copy kept in the test — a copy would keep
 *  passing after the implementation was rewritten, which is the regression this guards against. */
function plansOf(run: (store: BrainStore) => void): string[] {
  const db = openWorkDb(':memory:');
  const store = new BrainStore(db);
  const plans: string[] = [];
  const original = db.prepare.bind(db);
  (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
    const stmt = original(sql);
    if (!/^\s*(SELECT|WITH)/i.test(sql)) return stmt;
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

describe('descendantUsage skips the message scan for a childless session', () => {
  it('answers a session with no delegates without reading brain_messages at all', () => {
    const plans = plansOf((store) => {
      store.createSession({ id: 'solo', userId: 1, model: 'm' });
      expect(store.descendantUsage('solo')).toEqual({
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reasoning: 0, cost: 0,
      });
    });
    expect(plans.length).toBeGreaterThan(0);
    const joined = plans.join('\n');
    // `usage_rows` materializes the entire normalized view before the join can discard it, so touching
    // brain_messages here means a full scan with per-row json_extract — 0.7-1.8 s on the live database,
    // synchronously on the daemon event loop, for a row of zeros. 96.7% of sessions take this path, and
    // every idle/status emit goes through it, including the reconnect handshake a phone waits on.
    expect(joined).not.toMatch(/brain_messages/);
    expect(joined).toMatch(/brain_sessions/);
  });

  it('drives a real tree through the session index instead of materializing every message', () => {
    const plans = plansOf((store) => {
      store.createSession({ id: 'root', userId: 1, model: 'm' });
      store.createSession({ id: 'child', userId: 1, model: 'm', parentSessionId: 'root' });
      store.descendantUsage('root');
    });
    const joined = plans.join('\n');
    // A real tree is still read, but descendant ids must be the outer loop. The old normalized usage CTE
    // materialized all brain_messages first, blocking every status/reconnect request on the live database.
    expect(joined).toMatch(/SEARCH m USING INDEX idx_brain_messages_session \(session_id=\?\)/);
    expect(joined).not.toMatch(/MATERIALIZE usage_rows|SCAN a/);
  });
});
