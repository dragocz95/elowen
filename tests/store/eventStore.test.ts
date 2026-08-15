import { describe, it, expect, beforeEach } from 'vitest';
import type { Db } from '../../src/store/db.js';
import { openWorkDb } from '../helpers/workDb.js';
import { EventStore } from '../../src/store/eventStore.js';
import { refEventRow } from '../helpers/refStores.js';

// The store is wired the way brainCore wires it with a domain plugin ENABLED: a registered row resolver
// (here the reference one from refStores.ts) maps mission/review/decision/message/signal, so these
// tests can pin the row format core persists around them — type strings, details, label snapshots. The
// resolver-ABSENT degradation is covered below.
let db: Db;
let events: EventStore;
beforeEach(() => { db = openWorkDb(':memory:'); events = new EventStore(db, () => [refEventRow]); });

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
    events.record({ type: 'signal', session: 'elowen-Juno', signal: { type: 'working' } });
    events.record({ type: 'task', taskId: 'ghost', status: 'open' });
    const [task, signal] = events.list(); // newest-first
    expect(signal!.label).toBe('');
    expect(task!.label).toBe('');
  });
  it('records a message event as a JSON {role,text} detail, scoped+stamped to its task', () => {
    db.prepare("INSERT INTO projects (id, slug, path) VALUES (3, 'pm', '/pm')").run();
    db.prepare("INSERT INTO tasks (id, project_id, title, type) VALUES ('t-msg', 3, 'Chat task', 'task')").run();
    events.record({ type: 'message', taskId: 't-msg', role: 'agent', text: 'A or B?' });
    events.record({ type: 'message', taskId: 't-msg', role: 'autopilot', text: 'use A' });
    const rows = events.list({ type: 'message', target: 't-msg' }); // target-scoped ⇒ oldest-first (chronological)
    expect(rows.map((e) => JSON.parse(e.detail!))).toEqual([
      { role: 'agent', text: 'A or B?' },
      { role: 'autopilot', text: 'use A' },
    ]);
    expect(rows.every((e) => e.project_id === 3 && e.label === 'Chat task')).toBe(true);
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
  it('persists an autopilot decision as a JSON detail stamped against its task', () => {
    db.prepare("INSERT INTO projects (id, slug, path) VALUES (3, 'p', '/p')").run();
    db.prepare("INSERT INTO tasks (id, project_id, title, type) VALUES ('t-d', 3, 'Build it', 'task')").run();
    events.record({ type: 'decision', taskId: 't-d', kind: 'prompt', question: 'run migration?', outcome: 'approved', rationale: 'safe', confidence: 0.9 });
    const [row] = events.list();
    expect(row!.type).toBe('decision');
    expect(row!.target).toBe('t-d');
    expect(row!.project_id).toBe(3);
    expect(row!.label).toBe('Build it');
    expect(JSON.parse(row!.detail)).toMatchObject({ kind: 'prompt', question: 'run migration?', outcome: 'approved', rationale: 'safe', confidence: 0.9 });
  });
  it('does not persist a transient change ping', () => {
    events.record({ type: 'change', taskId: 't-c' });
    expect(events.list()).toEqual([]);
  });
  it('deleteForTarget removes a task\'s decisions along with its other events', () => {
    events.record({ type: 'decision', taskId: 'gone', kind: 'choice', question: 'which?', outcome: 'chose', rationale: 'best', confidence: 0.8, optionLabel: 'A' });
    events.record({ type: 'task', taskId: 'gone', status: 'closed' });
    events.deleteForTarget('gone');
    expect(events.list()).toEqual([]);
  });
  it('list({target}) returns one task\'s decision + review feed oldest-first', () => {
    events.record({ type: 'decision', taskId: 'feed', kind: 'prompt', question: 'q1', outcome: 'approved', rationale: 'r1', confidence: 0.7 });
    events.record({ type: 'review', missionId: 'm-x', taskId: 'feed', approve: false, rationale: 'r2' });
    events.record({ type: 'decision', taskId: 'other', kind: 'prompt', question: 'nope', outcome: 'approved', rationale: 'x', confidence: 0.5 });
    const feed = events.list({ target: 'feed' });
    expect(feed.map((e) => e.type)).toEqual(['decision', 'review']); // oldest-first (id ASC), scoped to 'feed'
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

describe('EventStore without the agents plugin resolver (plugin disabled)', () => {
  it('persists core-owned events but drops the agents-domain shapes', () => {
    const bare = new EventStore(db); // no row resolvers wired — the agents plugin is off
    bare.record({ type: 'task', taskId: 't1', status: 'open' });
    bare.record({ type: 'plugin', plugin: 'demo', kind: 'tick', projectId: null, data: { n: 1 } });
    bare.record({ type: 'mission', missionId: 'm1', state: 'active' });
    bare.record({ type: 'signal', session: 's1', signal: { type: 'working' } });
    bare.record({ type: 'review', missionId: 'm1', taskId: 't1', approve: true, rationale: 'ok' });
    expect(bare.list().map((e) => e.type)).toEqual(['plugin:demo', 'task']); // newest first
  });

  it('skips a throwing resolver instead of crashing the recorder', () => {
    const store = new EventStore(db, () => [() => { throw new Error('boom'); }, refEventRow]);
    store.record({ type: 'mission', missionId: 'm1', state: 'active' });
    expect(store.list().map((e) => [e.type, e.target, e.detail])).toEqual([['mission', 'm1', 'active']]);
  });
});
