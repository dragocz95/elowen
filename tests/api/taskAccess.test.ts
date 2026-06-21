import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { MissionStore } from '../../src/store/missionStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';

// Two projects: bob is assigned to #1 only; admin sees both. Cross-project task/mission access
// must be gated per-resource (by the resource's own project), not just by home-project membership.
function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'home','/o')").run();
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'other','/p2')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw');
  const bob = users.create('bob', 'pw');
  const userProjects = new UserProjectStore(db);
  userProjects.assign(bob.id, 1); // bob can reach the home project surface, not project 2
  const tasks = new TaskStore(db);
  tasks.create({ id: 't1', project_id: 1, title: 'home task' });
  tasks.create({ id: 't2', project_id: 2, title: 'foreign task' });
  tasks.create({ id: 'epic2', project_id: 2, title: 'E2', type: 'epic' });
  const missions = new MissionStore(db);
  missions.create({ id: 'm2', epic_id: 'epic2', autonomy: 'L3', max_sessions: 1 });
  const app = createServer({
    tasks, readiness: new Readiness(db), missions, bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db),
    users, projects: new ProjectStore(db), userProjects,
  });
  return { app, adminTok: users.issueToken(admin.id), bobTok: users.issueToken(bob.id) };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const patch = (t: string, body: unknown) => ({ method: 'PATCH', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const del = (t: string) => ({ method: 'DELETE', headers: { authorization: `Bearer ${t}` } });

describe('per-resource task/mission access', () => {
  it('GET /tasks lists only the caller-accessible projects', async () => {
    const { app, adminTok, bobTok } = setup();
    const bobTasks = await (await app.request('/tasks', auth(bobTok))).json() as { id: string }[];
    expect(bobTasks.map((t) => t.id).sort()).toEqual(['t1']); // not t2/epic2 (project 2)
    const adminTasks = await (await app.request('/tasks', auth(adminTok))).json() as { id: string }[];
    expect(adminTasks.map((t) => t.id).sort()).toEqual(['epic2', 't1', 't2']); // admin sees all
  });

  it('a non-admin cannot patch/delete/usage a task in a project they cannot access', async () => {
    const { app, bobTok } = setup();
    expect((await app.request('/tasks/t2', patch(bobTok, { title: 'hijack' }))).status).toBe(403);
    expect((await app.request('/tasks/t2', del(bobTok))).status).toBe(403);
    expect((await app.request('/tasks/t2/usage', auth(bobTok))).status).toBe(403);
    // …but their own project's task is fine.
    expect((await app.request('/tasks/t1', patch(bobTok, { title: 'ok' }))).status).toBe(200);
  });

  it('a non-admin cannot insert phases into a foreign epic', async () => {
    const { app, bobTok } = setup();
    expect((await app.request('/tasks/epic2/phases', { method: 'POST', headers: { authorization: `Bearer ${bobTok}`, 'content-type': 'application/json' }, body: JSON.stringify({ phases: [{ title: 'x' }] }) })).status).toBe(403);
  });

  it('GET /missions hides missions whose epic is in an inaccessible project', async () => {
    const { app, adminTok, bobTok } = setup();
    expect((await (await app.request('/missions', auth(bobTok))).json() as unknown[]).length).toBe(0);
    expect((await (await app.request('/missions', auth(adminTok))).json() as { id: string }[]).map((m) => m.id)).toEqual(['m2']);
  });

  it('a non-admin cannot view or control a foreign mission', async () => {
    const { app, bobTok } = setup();
    expect((await app.request('/missions/m2', auth(bobTok))).status).toBe(403);
    expect((await app.request('/missions/m2', patch(bobTok, { action: 'pause' }))).status).toBe(403);
    expect((await app.request('/missions/m2', del(bobTok))).status).toBe(403);
  });
});
