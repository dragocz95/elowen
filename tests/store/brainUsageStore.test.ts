import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDb, type Db } from '../../src/store/db.js';
import { BrainUsageStore } from '../../src/store/brainUsageStore.js';

// The /usage/by-model and /usage/by-day views each run two full scans of brain_messages behind a
// UNION ALL — the dashboard polls them every 30 s/60 s. The TTL cache (with its sentinel freshness
// probe) is what keeps those polls from re-paying the scan for an unchanged answer.
describe('BrainUsageStore view cache', () => {
  let db: Db;
  let now: number;
  let store: BrainUsageStore;

  const addSession = (id: string, userId = 1, model = 'm'): void => {
    db.prepare("INSERT INTO brain_sessions (id, user_id, model) VALUES (?, ?, ?)").run(id, userId, model);
  };
  const addUsage = (sessionId: string, id: string, totalTokens: number, tsMs: number): void => {
    db.prepare('INSERT INTO brain_messages (id, session_id, parent_id, role, content) VALUES (?, ?, NULL, ?, ?)')
      .run(id, sessionId, 'assistant', JSON.stringify({
        role: 'assistant', model: 'm', timestamp: tsMs,
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens },
      }));
  };
  /** Count the expensive aggregate passes (every USAGE_ROWS CTE scan), not the cheap sentinel probes. */
  const scans = (spy: ReturnType<typeof vi.spyOn<Db, 'prepare'>>): number =>
    spy.mock.calls.filter((call) => call[0].includes('usage_rows')).length;

  beforeEach(() => {
    db = openDb(':memory:');
    now = Date.parse('2026-07-29T12:00:00Z');
    store = new BrainUsageStore(db, () => now);
    addSession('s1');
    addUsage('s1', 'a', 100, now - 1000);
  });

  it('clears BOTH live and rolled-up spend, keeps the messages, and does not wait for the TTL', () => {
    // A compacted session carries its spend in `$.usageRollup`, so clearing only live `$.usage` would
    // leave the charts half-populated — the exact "the button did nothing" symptom being fixed.
    db.prepare('INSERT INTO brain_messages (id, session_id, parent_id, role, content) VALUES (?, ?, NULL, ?, ?)')
      .run('c1', 's1', 'compaction', JSON.stringify({
        role: 'compaction', text: 'summary of earlier turns',
        usageRollup: [{ model: 'm', at: now - 2000, input: 5, output: 7, totalTokens: 500 }],
      }));
    addSession('s2', 2);
    addUsage('s2', 'b', 900, now - 1000);
    expect(store.usageByModel(1).map((r) => r.usage.total)).toEqual([600]); // 100 live + 500 rolled up

    expect(store.clearUsage(1)).toBe(2);

    // Read again at the SAME instant: a cached view would still answer 600, because rewriting a column
    // moves no MAX(rowid) sentinel — so this also pins the explicit cache invalidation.
    expect(store.usageByModel(1)).toEqual([]);
    // Another user's spend is untouched, and the messages themselves survive with their text.
    expect(store.usageByModel(2).map((r) => r.usage.total)).toEqual([900]);
    const kept = db.prepare('SELECT content FROM brain_messages WHERE id = ?').get('c1') as { content: string };
    expect(JSON.parse(kept.content)).toMatchObject({ text: 'summary of earlier turns' });
    expect(db.prepare('SELECT COUNT(*) c FROM brain_messages').get()).toEqual({ c: 3 });
  });

  it('runs ONE table scan for repeated reads within the TTL, and re-scans once the TTL lapses', () => {
    const spy = vi.spyOn(db, 'prepare');
    expect(store.usageByModel(1).map((r) => r.usage.total)).toEqual([100]);
    store.usageByModel(1);
    store.usageByModel(1);
    expect(scans(spy)).toBe(1);

    now += 61_000;
    store.usageByModel(1);
    expect(scans(spy)).toBe(2);
  });

  it('sees a newly appended message immediately, without waiting for the TTL', () => {
    expect(store.usageByModel(1).map((r) => r.usage.total)).toEqual([100]);
    addUsage('s1', 'b', 50, now - 500); // the same instant — the TTL alone would keep the stale answer
    expect(store.usageByModel(1).map((r) => r.usage.total)).toEqual([150]);
  });

  it('shares one cache entry for two ISO spellings of the same window instant', () => {
    const spy = vi.spyOn(db, 'prepare');
    store.usageByModel(1, { fromIso: '2026-07-01T00:00:00.000Z' });
    store.usageByModel(1, { fromIso: '2026-07-01T00:00:00Z' });
    expect(scans(spy)).toBe(1);
  });

  it('caches usageByDay the same way', () => {
    const spy = vi.spyOn(db, 'prepare');
    store.usageByDay(1, 7);
    store.usageByDay(1, 7);
    expect(scans(spy)).toBe(1);
    addUsage('s1', 'b', 50, now - 500);
    store.usageByDay(1, 7);
    expect(scans(spy)).toBe(2);
  });
});
