import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { UsageOriginStore } from '../../src/store/usageOriginStore.js';
import { INTERNAL_ORIGIN, platformOrigin } from '../../src/api/clientIp.js';

const AT = Date.UTC(2026, 7, 17, 10, 0);
const ip = (value: string, trusted = true) => ({ value, kind: 'ip' as const, trusted });
const usage = (total: number, cost: number | null = null) => ({
  input: total, output: 0, cacheRead: 0, cacheWrite: 0, total, cost,
});
const setup = () => { const db = openDb(':memory:'); return { db, store: new UsageOriginStore(db) }; };

describe('UsageOriginStore attribution', () => {
  it('splits one user\'s spend across the addresses it came from', () => {
    const { store } = setup();
    store.recordRequest('brain-1', 7, ip('203.0.113.7'), AT);
    store.addTurn(7, store.settleTurn('brain-1').origin, usage(1000, 2), AT);
    store.recordRequest('brain-1', 7, ip('198.51.100.44'), AT + 1000);
    store.addTurn(7, store.settleTurn('brain-1').origin, usage(400, 1), AT + 1000);

    const rows = store.topOrigins({ group: 'pair' });
    // The BREAKDOWN is the assertion, not the sum: a total of 1400 would also come out of an
    // implementation that pinned the origin to the session instead of to the turn, which is wrong.
    expect(rows.map((r) => [r.origin, r.tokens, r.turns, r.cost])).toEqual([
      ['203.0.113.7', 1000, 1, 2],
      ['198.51.100.44', 400, 1, 1],
    ]);
    expect(store.topOrigins({ group: 'user' }).map((r) => [r.userId, r.tokens, r.origins]))
      .toEqual([[7, 1400, 2]]);
  });

  it('attributes a turn to the request that started it, not to one that arrives mid-turn', () => {
    const { store } = setup();
    store.recordRequest('brain-1', 7, ip('203.0.113.7'), AT);          // starts the turn
    store.recordRequest('brain-1', 7, ip('198.51.100.44'), AT + 500);  // steered INTO the running turn
    store.addTurn(7, store.settleTurn('brain-1').origin, usage(900), AT + 9000);

    expect(store.topOrigins({ group: 'pair' }).map((r) => [r.origin, r.tokens])).toEqual([['203.0.113.7', 900]]);
    // …and the ledger still records that the second address spoke into the conversation. Attribution and
    // "who talked here" are different questions and are answered from different places.
    const seen = store.topOrigins({ group: 'origin' }).map((r) => r.origin);
    expect(seen).toEqual(['203.0.113.7']);
  });

  it('starts a fresh pin for the next turn once one has settled', () => {
    const { store } = setup();
    store.recordRequest('brain-1', 7, ip('203.0.113.7'), AT);
    store.settleTurn('brain-1');
    store.recordRequest('brain-1', 7, ip('198.51.100.44'), AT + 1000);
    expect(store.pinnedOrigin('brain-1')).toEqual(ip('198.51.100.44'));
  });

  it('settles a turn nobody requested as internal, never as the last human address', () => {
    const { store } = setup();
    // A human used this conversation over HTTP earlier…
    store.recordRequest('brain-1', 7, ip('203.0.113.7'), AT);
    store.addTurn(7, store.settleTurn('brain-1').origin, usage(100), AT);
    // …and later a cron wake-up runs a turn in it with no request behind it at all.
    expect(store.settleTurn('brain-1')).toEqual({ origin: INTERNAL_ORIGIN, userId: null });
    store.addTurn(7, store.settleTurn('brain-1').origin, usage(500), AT + 86_400_000);

    const rows = store.topOrigins({ group: 'pair' });
    expect(rows.find((r) => r.origin === 'internal')?.tokens).toBe(500);
    expect(rows.find((r) => r.origin === '203.0.113.7')?.tokens).toBe(100);
  });

  it('keeps a bucket uncosted rather than turning an unknown price into $0', () => {
    const { store } = setup();
    store.addTurn(7, platformOrigin('discord'), usage(100, null), AT);
    expect(store.topOrigins({ group: 'pair' })[0]).toMatchObject({ cost: null, costedTurns: 0, tokens: 100 });
    store.addTurn(7, platformOrigin('discord'), usage(50, 0.25), AT);
    expect(store.topOrigins({ group: 'pair' })[0]).toMatchObject({ cost: 0.25, costedTurns: 1, tokens: 150 });
  });

  it('marks a bucket untrusted as soon as any of its turns was unverifiable', () => {
    const { store } = setup();
    store.addTurn(7, ip('203.0.113.7', true), usage(100), AT);
    store.addTurn(7, ip('203.0.113.7', false), usage(100), AT);
    // A bucket is only as trustworthy as its weakest contribution; averaging it back to "verified" would
    // present a claim as a fact.
    expect(store.topOrigins({ group: 'pair' })[0].trusted).toBe(false);
  });

  it('reports the day tracking began, so nobody reads the view as the whole history', () => {
    const { store } = setup();
    expect(store.trackingSince()).toBeNull();
    store.addTurn(7, ip('203.0.113.7'), usage(1), Date.UTC(2026, 7, 20, 5));
    store.addTurn(7, ip('203.0.113.7'), usage(1), Date.UTC(2026, 7, 17, 5));
    expect(store.trackingSince()).toBe('2026-08-17');
  });

  it('narrows to a window by UTC day', () => {
    const { store } = setup();
    store.addTurn(7, ip('203.0.113.7'), usage(100), Date.UTC(2026, 7, 10, 12));
    store.addTurn(7, ip('203.0.113.7'), usage(200), Date.UTC(2026, 7, 20, 12));
    expect(store.topOrigins({ fromIso: '2026-08-15T00:00:00Z' })[0].tokens).toBe(200);
    expect(store.topOrigins({ toIso: '2026-08-15T00:00:00Z' })[0].tokens).toBe(100);
  });
});
