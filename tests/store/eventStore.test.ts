import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '../../src/store/db.js';
import { EventStore } from '../../src/store/eventStore.js';

let db: Db;
let events: EventStore;
const memoryResolver = (event: Parameters<EventStore['record']>[0]) => event.type === 'memory'
  ? { type: 'memory-recall', target: String(event.userId), detail: 'recalled' }
  : undefined;

beforeEach(() => { db = openDb(':memory:'); events = new EventStore(db, () => [memoryResolver]); });

describe('EventStore', () => {
  it('persists core auth and plugin events', () => {
    events.record({ type: 'auth', kind: 'sso.login', subject: 'subject', detail: 'linked', label: 'Filip' });
    events.record({ type: 'plugin', plugin: 'demo', kind: 'tick', projectId: 7, data: { n: 1 } }, 7);
    expect(events.list().map((event) => [event.type, event.target, event.project_id])).toEqual([
      ['plugin:demo', 'tick', 7],
      ['sso.login', 'subject', null],
    ]);
  });

  it('lets a generic plugin resolver persist a core-transient event', () => {
    events.record({ type: 'memory', userId: 9 });
    expect(events.list().map((event) => [event.type, event.target, event.detail])).toEqual([
      ['memory-recall', '9', 'recalled'],
    ]);
  });

  it('skips a throwing resolver and continues to the next one', () => {
    const store = new EventStore(db, () => [() => { throw new Error('boom'); }, memoryResolver]);
    store.record({ type: 'memory', userId: 9 });
    expect(store.list()).toHaveLength(1);
  });

  it('filters, limits and deletes persisted plugin rows', () => {
    events.record({ type: 'plugin', plugin: 'demo', kind: 'gone', projectId: null, data: 1 });
    events.record({ type: 'plugin', plugin: 'demo', kind: 'gone', projectId: null, data: 2 });
    events.record({ type: 'plugin', plugin: 'demo', kind: 'keep', projectId: null, data: 3 });
    expect(events.list({ type: 'plugin:demo', limit: 1 })).toHaveLength(1);
    events.deleteForTarget('gone');
    expect(events.list().map((event) => event.target)).toEqual(['keep']);
    expect(events.deleteAll()).toBe(1);
    expect(events.list()).toEqual([]);
  });

  it('purges rows older than the retention window only', () => {
    events.record({ type: 'plugin', plugin: 'demo', kind: 'old', projectId: null, data: null });
    events.record({ type: 'plugin', plugin: 'demo', kind: 'fresh', projectId: null, data: null });
    db.prepare("UPDATE events SET ts = datetime('now','-40 days') WHERE target = 'old'").run();
    expect(events.purgeOlderThan(30)).toBe(1);
    expect(events.list().map((event) => event.target)).toEqual(['fresh']);
  });
});

// The team activity feed ("Dění"). Two properties carry it: identical events fold into one row at WRITE
// time (a feed nobody can read is worse than no feed), and the actor's name is resolved at READ time so
// a rename is reflected in the whole history instead of leaving stale copies behind.
describe('EventStore — team activity feed', () => {
  const turn = (over: Partial<Parameters<EventStore['record']>[0]> = {}) => ({
    type: 'activity' as const, kind: 'turn' as const, actorUserId: 1, surface: 'web' as const,
    target: 'brain-1', detail: 'claude-opus-5', ...over,
  });

  it('folds identical events into one row and counts them', () => {
    db.prepare("INSERT INTO users (id,username,password_hash,name) VALUES (1,'filip','x','Filip Džudža')").run();

    events.record(turn());
    events.record(turn({ target: 'brain-1-other' }));
    events.record(turn());

    const rows = events.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(3);
    // The row keeps the FIRST occurrence as its target; last_ts says when the latest one landed.
    expect(rows[0]!.target).toBe('brain-1');
    expect(rows[0]!.last_ts).toBeTruthy();
  });

  it('keeps a different actor or surface apart', () => {
    events.record(turn());
    events.record(turn({ actorUserId: 2 }));
    events.record(turn({ surface: 'cli' }));

    expect(events.list()).toHaveLength(3);
  });

  it('resolves the actor name at read time, preferring the display name', () => {
    db.prepare("INSERT INTO users (id,username,password_hash,name) VALUES (1,'filip','x','Filip Džudža')").run();
    db.prepare("INSERT INTO users (id,username,password_hash,name) VALUES (2,'bob','x','')").run();

    events.record(turn());
    events.record(turn({ actorUserId: 2 }));

    const byActor = new Map(events.list().map((e) => [e.actor_user_id, e.actor_label]));
    expect(byActor.get(1)).toBe('Filip Džudža');
    expect(byActor.get(2)).toBe('bob'); // username is the fallback when no display name is set

    // A rename must reach the whole history, which is exactly why the name is not stored on the row.
    db.prepare("UPDATE users SET name = 'Filip D.' WHERE id = 1").run();
    expect(events.list().find((e) => e.actor_user_id === 1)!.actor_label).toBe('Filip D.');
  });

  it('keeps the event when its account is gone, just without a name', () => {
    db.prepare("INSERT INTO users (id,username,password_hash,name) VALUES (9,'gone','x','Gone')").run();
    events.record(turn({ actorUserId: 9 }));
    db.prepare('DELETE FROM users WHERE id = 9').run();

    const [row] = events.list();
    expect(row!.actor_user_id).toBe(9);
    expect(row!.actor_label).toBe(''); // history outlives the account; it simply loses the label
  });

  it('leaves every other event shape unaggregated', () => {
    events.record({ type: 'plugin', plugin: 'demo', kind: 'tick', projectId: null, data: null });
    events.record({ type: 'plugin', plugin: 'demo', kind: 'tick', projectId: null, data: null });
    expect(events.list()).toHaveLength(2);
  });
});

// The heatmap reads an hourly rollup, never brain_messages: that table is the largest one and
// better-sqlite3 is synchronous, so grouping it per request would run on the daemon's event loop.
describe('EventStore — activity heatmap rollup', () => {
  const turn = (actorUserId: number | null) =>
    events.record({ type: 'activity', kind: 'turn', actorUserId, surface: 'web', target: 'brain-1' });

  it('counts every turn, even the ones the feed folds into one line', () => {
    turn(1); turn(1); turn(1);

    // The feed deliberately shows a burst as ONE row so it stays readable...
    expect(events.list().filter((r) => r.type === 'turn')).toHaveLength(1);
    // ...but the heatmap is about volume, so the two cannot share a counter.
    expect(events.heatmap(7).reduce((n, b) => n + b.count, 0)).toBe(3);
  });

  it('aggregates the whole team into one bucket per hour', () => {
    turn(1); turn(2); turn(3);

    const buckets = events.heatmap(7);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].count).toBe(3);
    expect(buckets[0].hour).toBeGreaterThanOrEqual(0);
  });

  it('keeps counting a turn that has no account behind it', () => {
    // A cron or an unlinked platform sender. SQLite treats every NULL in a primary key as distinct, so
    // storing the missing actor as NULL would stop the bucket folding and produce a row per turn.
    turn(null); turn(null);

    const rows = db.prepare('SELECT user_id, count FROM activity_buckets').all() as { user_id: number; count: number }[];
    expect(rows).toEqual([{ user_id: 0, count: 2 }]);
  });

  it('does not reach outside the window it was asked for', () => {
    turn(1);
    db.prepare("UPDATE activity_buckets SET day = strftime('%Y-%m-%d','now','-40 days')").run();

    expect(events.heatmap(7)).toEqual([]);
    expect(events.heatmap(60)).toHaveLength(1);
  });

  it('keeps the people apart for the ridgeline, which heatmap() folds together', () => {
    turn(1); turn(1); turn(2);

    // Same hour, same rollup — but the dashboard draws a layer per person and needs the split back.
    expect(events.heatmap(7)).toHaveLength(1);
    const byUser = events.heatmapByUser(7);
    expect(byUser.map((b) => [b.userId, b.count]).sort()).toEqual([[1, 2], [2, 1]]);
  });

  it('leaves the unattributed turns out of the per-user view', () => {
    turn(1); turn(null);

    // User 0 is the "nobody" bucket. It still belongs in the instance total, but a ridgeline layer
    // needs a name to label it with, so it is dropped here rather than drawn as a nameless ridge.
    expect(events.heatmap(7).reduce((n, b) => n + b.count, 0)).toBe(2);
    expect(events.heatmapByUser(7).map((b) => b.userId)).toEqual([1]);
  });

  it('does not reach outside the window for the per-user view either', () => {
    turn(1);
    db.prepare("UPDATE activity_buckets SET day = strftime('%Y-%m-%d','now','-40 days')").run();

    expect(events.heatmapByUser(7)).toEqual([]);
    expect(events.heatmapByUser(60)).toHaveLength(1);
  });
});
