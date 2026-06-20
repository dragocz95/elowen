import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { MissionStore } from '../../src/store/missionStore.js';
import { AgentStore } from '../../src/store/agentStore.js';
import { SpawnService } from '../../src/spawn/spawn.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw'); // first user → is_admin
  const bob = users.create('bob', 'pw');
  const userProjects = new UserProjectStore(db);
  const tasks = new TaskStore(db);
  const tmux = new FakeTmuxDriver();
  const app = createServer({
    tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: { disengage: async () => {} } as never, spawn: new SpawnService({ tmux, agents: new AgentStore(db) }), tmux,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db),
    users, projects: new ProjectStore(db), userProjects,
  });
  return { app, db, users, userProjects, tasks, tmux, admin, bob, adminTok: users.issueToken(admin.id), bobTok: users.issueToken(bob.id) };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const patch = (t: string, body: unknown) => ({ method: 'PATCH', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const post = (t: string, body: unknown) => ({ method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('PATCH /users/:id — admin manages permissions', () => {
  it('admin grants the admin role to another user', async () => {
    const { app, adminTok, bob } = setup();
    const res = await app.request(`/users/${bob.id}`, patch(adminTok, { is_admin: true }));
    expect(res.status).toBe(200);
    expect((await res.json()).is_admin).toBe(true);
  });

  it('admin sets a per-user model allow-list, filtered to the global allow-list', async () => {
    const { app, adminTok, bob } = setup();
    // 'sonnet' is globally allowed; 'bogus/model' is not → dropped.
    const res = await app.request(`/users/${bob.id}`, patch(adminTok, { allowed_execs: ['sonnet', 'bogus/model'] }));
    expect(res.status).toBe(200);
    expect((await res.json()).allowed_execs).toEqual(['sonnet']);
  });

  it('a non-admin cannot edit anyone (403)', async () => {
    const { app, bobTok, bob } = setup();
    expect((await app.request(`/users/${bob.id}`, patch(bobTok, { allowed_execs: ['sonnet'] }))).status).toBe(403);
  });

  it('refuses to demote the last admin', async () => {
    const { app, adminTok, admin } = setup();
    expect((await app.request(`/users/${admin.id}`, patch(adminTok, { is_admin: false }))).status).toBe(400);
  });

  it('404 for an unknown user', async () => {
    const { app, adminTok } = setup();
    expect((await app.request('/users/999', patch(adminTok, { is_admin: true }))).status).toBe(404);
  });
});

describe('per-user model allow-list enforcement', () => {
  it('blocks a restricted user from spawning a disallowed (but globally-allowed) exec', async () => {
    const { app, adminTok, bobTok, bob, userProjects, tasks, tmux } = setup();
    userProjects.assign(bob.id, 1);                                  // bob can reach the project surface
    await app.request(`/users/${bob.id}`, patch(adminTok, { allowed_execs: ['sonnet'] }));
    tasks.create({ id: 'orca-1', project_id: 1, title: 'X' });

    // 'deepseek/deepseek-v4-flash' is in the GLOBAL allow-list but not in bob's → 403, no spawn.
    const blocked = await app.request('/sessions', post(bobTok, { taskId: 'orca-1', exec: 'deepseek/deepseek-v4-flash' }));
    expect(blocked.status).toBe(403);
    expect(await tmux.list()).toHaveLength(0);

    // 'sonnet' is in bob's list → allowed.
    const ok = await app.request('/sessions', post(bobTok, { taskId: 'orca-1', exec: 'sonnet' }));
    expect(ok.status).toBe(201);
  });

  it('an empty allow-list imposes no per-user restriction, and the admin is unrestricted', async () => {
    const { app, adminTok, bobTok, bob, userProjects, tasks } = setup();
    userProjects.assign(bob.id, 1);
    tasks.create({ id: 'orca-1', project_id: 1, title: 'X' });
    // bob has no allowed_execs set → any globally-allowed exec works.
    expect((await app.request('/sessions', post(bobTok, { taskId: 'orca-1', exec: 'deepseek/deepseek-v4-flash' }))).status).toBe(201);
    tasks.create({ id: 'orca-2', project_id: 1, title: 'Y' });
    expect((await app.request('/sessions', post(adminTok, { taskId: 'orca-2', exec: 'codex:gpt-5.4' }))).status).toBe(201);
  });
});

describe('admin gates & input validation (batch 1 audit fixes)', () => {
  it('hermes status/install are admin-only (non-admin → 403)', async () => {
    const { app, adminTok, bobTok } = setup();
    expect((await app.request('/integrations/hermes/status', auth(bobTok))).status).toBe(403);
    expect((await app.request('/integrations/hermes/install', post(bobTok, { url: 'http://x', token: 't' }))).status).toBe(403);
    // admin clears the gate (status reads cleanly even if hermes isn't present)
    expect((await app.request('/integrations/hermes/status', auth(adminTok))).status).toBe(200);
  });

  it('POST /missions rejects a missing epicId (400) and an unknown epic (404) before touching the engine', async () => {
    const { app, adminTok } = setup();
    expect((await app.request('/missions', post(adminTok, {}))).status).toBe(400);
    expect((await app.request('/missions', post(adminTok, { epicId: 'nope' }))).status).toBe(404);
  });

  it('POST /sessions/:name/keys rejects non-array / flag-injection keys (400)', async () => {
    const { app, adminTok } = setup();
    expect((await app.request('/sessions/orca-Nova/keys', post(adminTok, { keys: 'Enter' }))).status).toBe(400);
    expect((await app.request('/sessions/orca-Nova/keys', post(adminTok, { keys: [] }))).status).toBe(400);
    expect((await app.request('/sessions/orca-Nova/keys', post(adminTok, { keys: ['-t', 'other', 'C-c'] }))).status).toBe(400);
    // a clean key list is accepted
    expect((await app.request('/sessions/orca-Nova/keys', post(adminTok, { keys: ['Enter'] }))).status).toBe(200);
  });

  it('POST /admin/cleanup is admin-only and wipes all tasks + missions', async () => {
    const { app, adminTok, bobTok, tasks, db } = setup();
    tasks.create({ id: 'orca-1', project_id: 1, title: 'X' });
    tasks.create({ id: 'orca-2', project_id: 1, title: 'Y', type: 'epic' });
    db.prepare("INSERT INTO missions (id,epic_id,autonomy,state) VALUES ('m1','orca-2','L3','active')").run();
    expect((await app.request('/admin/cleanup', post(bobTok, {}))).status).toBe(403); // non-admin blocked
    const res = await app.request('/admin/cleanup', post(adminTok, {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, tasks: 2, missions: 1 });
    expect(tasks.list()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) c FROM missions').get()).toEqual({ c: 0 });
  });

  it('DELETE /tasks/:id?subtree=1 removes the epic, its children and the mission', async () => {
    const { app, adminTok, tasks, db } = setup();
    tasks.create({ id: 'orca-ep', project_id: 1, title: 'Epic', type: 'epic' });
    tasks.create({ id: 'orca-c1', project_id: 1, title: 'C1', parent_id: 'orca-ep' });
    tasks.create({ id: 'orca-c2', project_id: 1, title: 'C2', parent_id: 'orca-ep' });
    db.prepare("INSERT INTO missions (id,epic_id,autonomy,state) VALUES ('m-ep','orca-ep','L3','active')").run();
    tasks.create({ id: 'orca-keep', project_id: 1, title: 'Keep' });

    const res = await app.request('/tasks/orca-ep?subtree=1', { method: 'DELETE', headers: { authorization: `Bearer ${adminTok}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, tasks: 3 });
    expect(tasks.get('orca-ep')).toBeNull();
    expect(tasks.get('orca-c1')).toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM missions').get()).toEqual({ c: 0 });
    expect(tasks.get('orca-keep')).not.toBeNull();
  });
});
