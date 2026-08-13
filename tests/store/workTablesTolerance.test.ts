import { describe, it, expect } from 'vitest';
import { openDb, type Db } from '../../src/store/db.js';
import { openWorkDb } from '../helpers/workDb.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { EventStore } from '../../src/store/eventStore.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { TaskRefs } from '../../src/store/taskRefs.js';
import { agentsEventRow } from '../../plugins/agents/src/events/rows.js';

/** The fresh-install ON/OFF matrix for the core paths that still touch the WORK-PLUGIN-owned tables
 *  (tasks/task_deps/task_usage). OFF = plain openDb, whose schema no longer carries them; ON = openWorkDb,
 *  the plugin's migrations applied. Every path must work in BOTH shapes: tolerant of the tables' absence,
 *  and still purging/reading the plugin's rows when they exist — a cleanup that quietly skipped while the
 *  plugin was off would strand orphans that resurface the moment it is switched back on.
 *
 *  The counterpart for the agents tables is tests/store/agentsTablesTolerance.test.ts; that the schema
 *  itself is unchanged by the move is tests/store/taskSchemaParity.test.ts. */

/** Arrange a project, an epic and a phase with a dependency edge, plus a usage snapshot. */
function seedTaskSubtree(db: Db, projectId = 1): void {
  db.prepare("INSERT INTO tasks (id, project_id, title, type) VALUES ('e-1', ?, 'Epic', 'epic')").run(projectId);
  db.prepare("INSERT INTO tasks (id, project_id, title, parent_id) VALUES ('t-1', ?, 'Phase', 'e-1')").run(projectId);
  db.prepare("INSERT INTO task_deps (task_id, depends_on_id) VALUES ('t-1', 'e-1')").run();
}

const usageMsg = (store: BrainStore, session: string, id: string, total: number, cost: number) =>
  store.appendMessage({
    id, sessionId: session, parentId: null, role: 'assistant',
    content: { role: 'assistant', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: total, cost: { total: cost } }, timestamp: Date.now() },
  });

describe('work tables tolerance (fresh install, plugin OFF)', () => {
  it('project delete runs without the task tables', () => {
    const db = openDb(':memory:');
    const projects = new ProjectStore(db);
    const p = projects.create({ slug: 'p', path: '/o' });
    expect(projects.remove(p.id)).toBe(true);
    expect(projects.get(p.id)).toBeNull();
  });

  it('user delete runs without the task tables (created_by nulling skipped)', () => {
    const db = openDb(':memory:');
    const users = new UserStore(db);
    const u = users.create('bob', 'pw');
    users.delete(u.id);
    expect(users.list().some((x) => x.username === 'bob')).toBe(false);
  });

  it('the timeline still records an event whose label would have come from a task', () => {
    const db = openDb(':memory:');
    const events = new EventStore(db, () => [agentsEventRow]);
    events.record({ type: 'task', taskId: 't-1', status: 'open' });
    const [row] = events.list();
    expect(row!.type).toBe('task');
    expect(row!.target).toBe('t-1');
    // No task table to derive them from — recorded honestly as "unknown", never as a crash.
    expect(row!.project_id ?? null).toBeNull();
    expect(row!.label).toBe('');
  });

  it('the usage views serve chat spend instead of failing on the missing snapshot table', () => {
    const db = openDb(':memory:');
    const store = new BrainStore(db);
    store.createSession({ id: 'brain-a', userId: 1, model: 'claude-opus-4-8' });
    usageMsg(store, 'brain-a', 'm1', 100, 0.1);
    // A task worker's session with nothing to exclude it: with no task_usage table nothing is
    // snapshotted anywhere, so its spend is KEPT rather than vanishing from every stat.
    store.createSession({ id: 'brain-task-9', userId: 1, model: 'claude-opus-4-8' });
    usageMsg(store, 'brain-task-9', 't1', 40, 0.04);
    const rows = store.usageByModel(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.usage.total).toBe(140);
    expect(store.usageByDay(1).reduce((n, d) => n + d.tokens, 0)).toBe(140);
  });

  it('the tenancy view answers EMPTY, so an agent token reaches no project at all', () => {
    const refs = new TaskRefs(openDb(':memory:'));
    expect(refs.all()).toEqual([]);
    expect(refs.get('t-1')).toBeNull();
  });
});

describe('work tables purge (plugin ON — tables exist)', () => {
  it('project delete purges its tasks and their dependency edges', () => {
    const db = openWorkDb();
    const projects = new ProjectStore(db);
    const p = projects.create({ slug: 'p', path: '/o' });
    seedTaskSubtree(db, p.id);
    expect(projects.remove(p.id)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) c FROM tasks').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM task_deps').get()).toEqual({ c: 0 });
  });

  it('user delete nulls tasks.created_by (no dangling/recycled attribution)', () => {
    const db = openWorkDb();
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'p','/o')").run();
    const users = new UserStore(db);
    const u = users.create('bob', 'pw');
    db.prepare("INSERT INTO tasks (id, project_id, title, created_by) VALUES ('t-1', 1, 'T', ?)").run(u.id);
    users.delete(u.id);
    expect(db.prepare("SELECT created_by FROM tasks WHERE id = 't-1'").get()).toEqual({ created_by: null });
  });

  it('the timeline stamps an event with its task\'s project and title', () => {
    const db = openWorkDb();
    db.prepare("INSERT INTO projects (id, slug, path) VALUES (7, 'proj', '/p')").run();
    db.prepare("INSERT INTO tasks (id, project_id, title, type) VALUES ('t-1', 7, 'Rewrite docs', 'task')").run();
    const events = new EventStore(db, () => [agentsEventRow]);
    events.record({ type: 'task', taskId: 't-1', status: 'open' });
    const [row] = events.list();
    expect(row!.project_id).toBe(7);
    expect(row!.label).toBe('Rewrite docs');
  });

  it('the usage views exclude a task worker whose spend is already snapshotted', () => {
    const db = openWorkDb();
    const store = new BrainStore(db);
    store.createSession({ id: 'brain-a', userId: 1, model: 'claude-opus-4-8' });
    usageMsg(store, 'brain-a', 'm1', 100, 0.1);
    store.createSession({ id: 'brain-task-9', userId: 1, model: 'claude-opus-4-8' });
    usageMsg(store, 'brain-task-9', 't1', 999, 9.9);
    db.prepare("INSERT INTO task_usage (task_id, project_id, exec, total) VALUES ('9', 1, 'elowen:claude-opus-4-8', 1)").run();
    const rows = store.usageByModel(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.usage.total).toBe(100); // the snapshotted 999 is NOT counted twice
  });

  it('the tenancy view reads the task rows it is given', () => {
    const db = openWorkDb();
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'p','/o')").run();
    seedTaskSubtree(db);
    const refs = new TaskRefs(db);
    expect(refs.all().map((r) => r.id).sort()).toEqual(['e-1', 't-1']);
    expect(refs.get('t-1')?.parent_id).toBe('e-1');
  });
});
