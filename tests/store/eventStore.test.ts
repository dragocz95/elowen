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
  it('stamps task/review events with the task\'s project_id and leaves signal/mission null', () => {
    db.prepare("INSERT INTO projects (id, slug, path) VALUES (7, 'proj', '/p')").run();
    db.prepare("INSERT INTO tasks (id, project_id, title, type) VALUES ('t-p', 7, 'T', 'task')").run();
    events.record({ type: 'task', taskId: 't-p', status: 'open' });
    events.record({ type: 'review', missionId: 'm1', taskId: 't-p', approve: true, rationale: 'ok' });
    events.record({ type: 'signal', session: 's1', signal: { type: 'working' } });
    const [sig, review, task] = events.list(); // newest-first
    expect(task!.project_id).toBe(7);
    expect(review!.project_id).toBe(7);
    expect(sig!.project_id ?? null).toBeNull();
  });
  it('records a task event for an unknown task with a null project_id (no throw)', () => {
    events.record({ type: 'task', taskId: 'ghost', status: 'open' });
    expect(events.list()[0]!.project_id ?? null).toBeNull();
  });
  it('snapshots a human label at write time so it survives the task/epic being deleted', () => {
    db.prepare("INSERT INTO projects (id, slug, path) VALUES (1, 'p', '/p')").run();
    db.prepare("INSERT INTO tasks (id, project_id, title, type) VALUES ('t-x', 1, 'Rewrite docs', 'task')").run();
    db.prepare("INSERT INTO tasks (id, project_id, title, type) VALUES ('epic-1', 1, 'Docs autopilot', 'epic')").run();
    events.record({ type: 'task', taskId: 't-x', status: 'open' });
    events.record({ type: 'review', missionId: 'm-epic-1', taskId: 't-x', approve: true, rationale: 'ok' });
    events.record({ type: 'mission', missionId: 'm-epic-1', state: 'active' });
    db.prepare('DELETE FROM tasks').run(); // tasks gone — the snapshotted labels must remain
    const [mission, review, task] = events.list(); // newest-first
    expect(task!.label).toBe('Rewrite docs');
    expect(review!.label).toBe('Rewrite docs');
    expect(mission!.label).toBe('Docs autopilot');
  });
  it('leaves the label empty for signals and unknown tasks', () => {
    events.record({ type: 'signal', session: 'orca-Juno', signal: { type: 'working' } });
    events.record({ type: 'task', taskId: 'ghost', status: 'open' });
    const [task, signal] = events.list(); // newest-first
    expect(signal!.label).toBe('');
    expect(task!.label).toBe('');
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
