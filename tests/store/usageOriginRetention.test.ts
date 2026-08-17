import { describe, it, expect } from 'vitest';
import { openDb, type Db } from '../../src/store/db.js';
import { UsageOriginStore } from '../../src/store/usageOriginStore.js';

const DAY = 86_400_000;
const ip = (value: string, trusted = true) => ({ value, kind: 'ip' as const, trusted });
const usage = (total: number, cost: number | null = null) => ({
  input: total, output: 0, cacheRead: 0, cacheWrite: 0, total, cost,
});

function setup(): { db: Db; store: UsageOriginStore } {
  const db = openDb(':memory:');
  return { db, store: new UsageOriginStore(db) };
}

describe('UsageOriginStore retention', () => {
  it('redacts an aged-out IP while keeping its totals, and merges the buckets of one day', () => {
    const { db, store } = setup();
    const old = Date.UTC(2026, 0, 10, 12);
    store.addTurn(7, ip('203.0.113.7'), usage(1000, 2), old);
    store.addTurn(7, ip('198.51.100.44'), usage(500, 1), old);
    // Same user, same day, but recent — must survive untouched.
    const recent = Date.UTC(2026, 1, 20, 12);
    store.addTurn(7, ip('203.0.113.7'), usage(300, 0.5), recent);

    const folded = store.redactOlderThan(old + DAY);
    expect(folded).toBe(2);

    const rows = db.prepare('SELECT origin, origin_kind, turns, total, cost FROM usage_by_origin ORDER BY day, origin').all();
    expect(rows).toEqual([
      // The two January buckets became one, summed — the spend is intact, the addresses are gone.
      { origin: 'redacted', origin_kind: 'redacted', turns: 2, total: 1500, cost: 3 },
      { origin: '203.0.113.7', origin_kind: 'ip', turns: 1, total: 300, cost: 0.5 },
    ]);
  });

  it('leaves non-address origins alone — they name no person', () => {
    const { db, store } = setup();
    const old = Date.UTC(2026, 0, 10, 12);
    store.addTurn(7, { value: 'internal', kind: 'internal', trusted: true }, usage(10), old);
    store.addTurn(7, { value: 'platform:discord', kind: 'platform', trusted: true }, usage(20), old);
    store.addTurn(7, { value: 'local', kind: 'local', trusted: true }, usage(30), old);

    store.redactOlderThan(old + DAY);
    const kinds = (db.prepare('SELECT origin FROM usage_by_origin ORDER BY origin').all() as { origin: string }[]).map((r) => r.origin);
    // Blurring these would erase the very distinction the view exists to draw (a human address vs a cron
    // job vs a chat bridge) without protecting anybody.
    expect(kinds).toEqual(['internal', 'local', 'platform:discord']);
  });

  it('folds an aged-out IP into an existing redacted bucket rather than failing on the key', () => {
    const { db, store } = setup();
    const old = Date.UTC(2026, 0, 10, 12);
    store.addTurn(7, ip('203.0.113.7'), usage(100, 1), old);
    store.redactOlderThan(old + DAY);
    store.addTurn(7, ip('198.51.100.44'), usage(50, null), old + 1);
    store.redactOlderThan(old + DAY);

    expect(db.prepare('SELECT turns, total, cost, costed_turns FROM usage_by_origin').all())
      .toEqual([{ turns: 2, total: 150, cost: 1, costed_turns: 1 }]);
  });

  it('clears the ingress ledger on the same horizon and purges the row on the longer one', () => {
    const { db, store } = setup();
    const old = Date.UTC(2026, 0, 10, 12);
    store.recordRequest('brain-1', 7, ip('203.0.113.7'), old);
    store.addTurn(7, ip('203.0.113.7'), usage(100), old);

    store.redactOlderThan(old + DAY);
    // The ledger's only job is live attribution; past the horizon there is nothing left to attribute.
    expect(db.prepare('SELECT COUNT(*) c FROM brain_session_origins').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM usage_by_origin').get()).toEqual({ c: 1 });

    expect(store.purgeOlderThan(old + 2 * DAY)).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM usage_by_origin').get()).toEqual({ c: 0 });
  });

  it('clearForUser drops one user\'s accounting and leaves everyone else\'s', () => {
    const { db, store } = setup();
    const at = Date.UTC(2026, 1, 20, 12);
    store.recordRequest('brain-1', 7, ip('203.0.113.7'), at);
    store.addTurn(7, ip('203.0.113.7'), usage(100), at);
    store.addTurn(9, ip('198.51.100.44'), usage(200), at);

    expect(store.clearForUser(7)).toBe(1);
    expect(db.prepare('SELECT user_id, total FROM usage_by_origin').all()).toEqual([{ user_id: 9, total: 200 }]);
    expect(db.prepare('SELECT COUNT(*) c FROM brain_session_origins').get()).toEqual({ c: 0 });
  });
});
