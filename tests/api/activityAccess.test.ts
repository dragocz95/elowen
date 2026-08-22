import { describe, it, expect } from 'vitest';
import { TaskRefs } from '../../src/store/taskRefs.js';
import { EventStore } from '../../src/store/eventStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';
import { RefMissions, RefReadiness, RefTaskStore, refEventRow } from '../helpers/refStores.js';

// Two projects; bob assigned to #1. The activity timeline carries task/mission ids + statuses, so it
// must be scoped per-project — a tenant sees only their projects' events, never the whole daemon's.
function setup() {
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'home','/o')").run();
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'other','/p2')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw');
  const bob = users.create('bob', 'pw');
  const userProjects = new UserProjectStore(db);
  userProjects.assign(bob.id, 1);
  const tasks = new RefTaskStore(db);
  tasks.create({ id: 't1', project_id: 1, title: 'home task' });
  tasks.create({ id: 't2', project_id: 2, title: 'foreign task' });
  const events = new EventStore(db, () => [refEventRow]);
  // task events stamp their project internally; mission events get the project passed in (as the bus
  // subscriber does in bootstrap). A legacy event with no resolvable project stays null → admin-only.
  events.record({ type: 'task', taskId: 't1', status: 'open' });
  events.record({ type: 'task', taskId: 't2', status: 'open' });
  events.record({ type: 'mission', missionId: 'm-e1', state: 'active' }, 1);
  events.record({ type: 'mission', missionId: 'm-e2', state: 'active' }, 2);
  events.record({ type: 'task', taskId: 'gone', status: 'open' }); // unresolved → project_id null
  const app = createServer({
    tasks, taskRefs: new TaskRefs(db), readiness: new RefReadiness(db), missions: new RefMissions(db), bus: new EventBus(), events,
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db),
    users, projects: new ProjectStore(db), userProjects,
  });
  return { app, events, adminTok: users.issueToken(admin.id), bobTok: users.issueToken(bob.id) };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const targets = async (app: ReturnType<typeof setup>['app'], tok: string) =>
  ((await (await app.request('/activity', auth(tok))).json()) as { target: string }[]).map((r) => r.target).sort();

describe('GET /activity tenancy filtering', () => {
  it('shows a non-admin only their projects\' events (no null-project leak)', async () => {
    const { app, bobTok } = setup();
    expect(await targets(app, bobTok)).toEqual(['m-e1', 't1'].sort()); // not t2/m-e2 (project 2), not the null-project row
  });

  it('shows an admin the whole timeline', async () => {
    const { app, adminTok } = setup();
    expect(await targets(app, adminTok)).toEqual(['gone', 'm-e1', 'm-e2', 't1', 't2'].sort());
  });
});

describe('GET /activity?target — per-task conversation feed', () => {
  function setupTask() {
    const db = openPluginTablesDb(':memory:');
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'home','/o')").run();
    const users = new UserStore(db);
    const admin = users.create('admin', 'pw');
    const tasks = new RefTaskStore(db);
    tasks.create({ id: 'tk', project_id: 1, title: 'Task' });
    tasks.create({ id: 'other', project_id: 1, title: 'Other' });
    const events = new EventStore(db, () => [refEventRow]);
    events.record({ type: 'decision', taskId: 'tk', kind: 'prompt', question: 'run it?', outcome: 'approved', rationale: 'safe', confidence: 0.9 });
    events.record({ type: 'task', taskId: 'tk', status: 'in_progress' });
    events.record({ type: 'review', missionId: 'm-x', taskId: 'tk', approve: false, rationale: 'redo' });
    events.record({ type: 'decision', taskId: 'other', kind: 'prompt', question: 'nope', outcome: 'approved', rationale: 'x', confidence: 0.5 });
    const app = createServer({
      tasks, taskRefs: new TaskRefs(db), readiness: new RefReadiness(db), missions: new RefMissions(db), bus: new EventBus(), events,
      engine: null as never, spawn: null as never, tmux: null as never,
      project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
      clock: new FakeClock(0), config: new ConfigStore(db), users, projects: new ProjectStore(db),
    });
    return { app, tok: users.issueToken(admin.id) };
  }

  it('returns one task\'s events oldest-first, scoped to that target', async () => {
    const { app, tok } = setupTask();
    const rows = (await (await app.request('/activity?target=tk', auth(tok))).json()) as { type: string; target: string }[];
    expect(rows.every((r) => r.target === 'tk')).toBe(true);       // not 'other'
    expect(rows.map((r) => r.type)).toEqual(['decision', 'task', 'review']); // id ASC (chronological)
  });
});

describe('EventStore.record project stamping', () => {
  it('honors a passed-in project for non-task events, else falls back to the task lookup', () => {
    const db = openPluginTablesDb(':memory:');
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'home','/o')").run();
    const tasks = new RefTaskStore(db);
    tasks.create({ id: 't1', project_id: 1, title: 'x' });
    const events = new EventStore(db, () => [refEventRow]);
    events.record({ type: 'mission', missionId: 'm-e1', state: 'active' }, 7); // explicit
    events.record({ type: 'task', taskId: 't1', status: 'open' });             // fallback → 1
    events.record({ type: 'mission', missionId: 'm-e2', state: 'active' });    // no arg, not a task → null
    const rows = events.list();
    expect(rows.find((r) => r.target === 'm-e1')!.project_id).toBe(7);
    expect(rows.find((r) => r.target === 't1')!.project_id).toBe(1);
    expect(rows.find((r) => r.target === 'm-e2')!.project_id).toBeNull();
  });
});

// The team feed is the ONE deliberate exception to project scoping: Filip's decision that everyone sees
// the same activity. It is safe only because of what the row does NOT carry -- no message text, no
// conversation titles, no commands, no paths. Everything else must stay fail-closed for a tenant.
describe('GET /activity — the instance-wide team feed', () => {
  it('reaches a tenant even though it belongs to no project', async () => {
    const { app, events, bobTok } = setup();
    events.record({ type: 'activity', kind: 'turn', actorUserId: 1, surface: 'cli', target: 'brain-1', detail: 'opus' });
    const rows = await (await app.request('/activity', auth(bobTok))).json() as { type: string; surface: string; actor_label: string }[];

    const feed = rows.filter((r) => r.type === 'turn');
    expect(feed).toHaveLength(1);
    expect(feed[0]!.surface).toBe('cli');
    expect(feed[0]!.actor_label).toBe('admin'); // resolved by JOIN at read time, username as fallback
  });

  it('still withholds every project-scoped event the tenant cannot reach', async () => {
    const { app, events, bobTok } = setup();
    events.record({ type: 'activity', kind: 'turn', actorUserId: 1, surface: 'cli', target: 'brain-1', detail: 'opus' });
    const rows = await (await app.request('/activity', auth(bobTok))).json() as { type: string; target: string }[];

    const targets = rows.map((r) => r.target);
    expect(targets).toContain('t1'); // bob's own project
    expect(targets).not.toContain('t2'); // foreign project
    expect(targets).not.toContain('m-e2');
    expect(targets).not.toContain('gone'); // unresolved project stays admin-only
  });
});
