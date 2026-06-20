import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/store/db.js';
import type { Db } from '../../src/store/db.js';
import { EventStore } from '../../src/store/eventStore.js';

let db: Db;
let events: EventStore;
beforeEach(() => { db = openDb(':memory:'); events = new EventStore(db); });

describe('EventStore', () => {
  it('records each event kind to the right row', () => {
    events.record({ type: 'task', taskId: 't1', status: 'open' });
    events.record({ type: 'mission', missionId: 'm1', state: 'active' });
    events.record({ type: 'signal', session: 's1', signal: { type: 'working' } });
    const all = events.list();
    expect(all.map((e) => [e.type, e.target, e.detail])).toEqual([
      ['signal', 's1', 'working'],
      ['mission', 'm1', 'active'],
      ['task', 't1', 'open'],
    ]); // newest first (id DESC)
  });
  it('respects limit and type filter', () => {
    events.record({ type: 'task', taskId: 'a', status: 'open' });
    events.record({ type: 'task', taskId: 'b', status: 'closed' });
    events.record({ type: 'mission', missionId: 'm', state: 'active' });
    expect(events.list({ limit: 1 })).toHaveLength(1);
    expect(events.list({ type: 'task' }).every((e) => e.type === 'task')).toBe(true);
    expect(events.list({ type: 'task' })).toHaveLength(2);
  });
  it('deleteForTarget removes every event for that target only', () => {
    events.record({ type: 'task', taskId: 'gone', status: 'open' });
    events.record({ type: 'task', taskId: 'gone', status: 'closed' });
    events.record({ type: 'task', taskId: 'gone', status: 'cancelled' });
    events.record({ type: 'task', taskId: 'keep', status: 'open' });
    events.deleteForTarget('gone');
    const all = events.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.target).toBe('keep');
  });
  it('deleteAll wipes the whole feed and returns the count', () => {
    events.record({ type: 'task', taskId: 'a', status: 'open' });
    events.record({ type: 'mission', missionId: 'm', state: 'active' });
    expect(events.deleteAll()).toBe(2);
    expect(events.list()).toEqual([]);
  });
  it('purgeOlderThan drops events past the retention window only', () => {
    events.record({ type: 'task', taskId: 'old', status: 'open' });
    events.record({ type: 'task', taskId: 'fresh', status: 'open' });
    // Backdate the first event 40 days.
    db.prepare("UPDATE events SET ts = datetime('now','-40 days') WHERE target = 'old'").run();
    const removed = events.purgeOlderThan(30);
    expect(removed).toBe(1);
    const all = events.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.target).toBe('fresh');
  });
});
