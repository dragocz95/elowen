import { describe, it, expect, vi } from 'vitest';
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

function setup(extra: { engine?: unknown; missionGit?: unknown } = {}) {
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
    engine: (extra.engine ?? { disengage: async () => {} }) as never, spawn: new SpawnService({ tmux, agents: new AgentStore(db) }), tmux,
    missionGit: extra.missionGit as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db),
    users, projects: new ProjectStore(db), userProjects,
  });
  return { app, db, users, userProjects, tasks, tmux, admin, bob, adminTok: users.issueToken(admin.id), bobTok: users.issueToken(bob.id) };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const patch = (t: string, body: unknown) => ({ method: 'PATCH', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const post = (t: string, body: unknown) => ({ method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const del = (t: string) => ({ method: 'DELETE', headers: { authorization: `Bearer ${t}` } });

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

describe('RBAC tightening — /users directory & deletion are admin-only', () => {
  it('GET /users is admin-only (non-admin → 403, admin → roster)', async () => {
    const { app, adminTok, bobTok } = setup();
    expect((await app.request('/users', auth(bobTok))).status).toBe(403);
    const ok = await app.request('/users', auth(adminTok));
    expect(ok.status).toBe(200);
    expect((await ok.json()).length).toBe(2);
  });

  it('DELETE /users/:id is admin-only — a non-admin cannot delete another user', async () => {
    const { app, adminTok, bobTok, users } = setup();
    const carol = users.create('carol', 'pw'); // third, non-admin
    // Before the guard bob could wipe carol; now it's 403 and carol survives.
    expect((await app.request(`/users/${carol.id}`, del(bobTok))).status).toBe(403);
    expect(users.get(carol.id)).not.toBeNull();
    // Admin can still delete.
    expect((await app.request(`/users/${carol.id}`, del(adminTok))).status).toBe(200);
    expect(users.get(carol.id)).toBeNull();
  });
});

describe('admin impersonation (sign in as)', () => {
  it('admin gets a token that authenticates as the target; non-admin/self/unknown are rejected', async () => {
    const { app, adminTok, bobTok, admin, bob } = setup();
    expect((await app.request(`/users/${admin.id}/impersonate`, post(bobTok, {}))).status).toBe(403); // non-admin blocked
    expect((await app.request(`/users/${admin.id}/impersonate`, post(adminTok, {}))).status).toBe(400); // self rejected
    expect((await app.request('/users/999/impersonate', post(adminTok, {}))).status).toBe(404); // unknown target
    const res = await app.request(`/users/${bob.id}/impersonate`, post(adminTok, {}));
    expect(res.status).toBe(200);
    const { token, user } = await res.json();
    expect(user.id).toBe(bob.id);
    // the issued token really acts as bob
    expect((await (await app.request('/auth/me', auth(token))).json()).user.id).toBe(bob.id);
  });
});

describe('RBAC tightening — task deps respect project access', () => {
  it('GET /tasks/:id/deps 403s for a task in a project the caller cannot access, 404s for unknown', async () => {
    const { app, bobTok, userProjects, tasks, db, bob } = setup();
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'other','/x')").run();
    userProjects.assign(bob.id, 1); // clears the home-project middleware gate, but NOT project 2
    tasks.create({ id: 'orca-p2', project_id: 2, title: 'Foreign' });
    expect((await app.request('/tasks/orca-p2/deps', auth(bobTok))).status).toBe(403);
    expect((await app.request('/tasks/nope/deps', auth(bobTok))).status).toBe(404);
  });

  it('a non-admin assigned only to a NON-home project passes the coarse gate and sees just that project', async () => {
    const { app, bobTok, userProjects, tasks, db, bob } = setup();
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'sarah','/s')").run();
    userProjects.assign(bob.id, 2); // assigned to project 2 only — NOT the daemon's home project (1)
    tasks.create({ id: 'orca-home', project_id: 1, title: 'Home' });
    tasks.create({ id: 'orca-sarah', project_id: 2, title: 'Sarah' });
    const res = await app.request('/tasks', auth(bobTok));
    expect(res.status).toBe(200); // the gate no longer keys on the home project
    expect((await res.json()).map((t: { id: string }) => t.id)).toEqual(['orca-sarah']); // scoped to project 2
  });

  it('GET /tasks/deps only returns edges for accessible projects (admin sees all)', async () => {
    const { app, adminTok, bobTok, userProjects, tasks, db, bob } = setup();
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'other','/x')").run();
    userProjects.assign(bob.id, 1);
    tasks.create({ id: 'orca-a', project_id: 1, title: 'A' });
    tasks.create({ id: 'orca-b', project_id: 1, title: 'B' });
    tasks.setDeps('orca-b', ['orca-a']); // edge inside project 1
    tasks.create({ id: 'orca-x', project_id: 2, title: 'X' });
    tasks.create({ id: 'orca-y', project_id: 2, title: 'Y' });
    tasks.setDeps('orca-y', ['orca-x']); // edge inside project 2

    const bobDeps = await (await app.request('/tasks/deps', auth(bobTok))).json();
    expect(bobDeps).toEqual([{ task_id: 'orca-b', depends_on_id: 'orca-a' }]); // only project 1
    const adminDeps = await (await app.request('/tasks/deps', auth(adminTok))).json();
    expect(adminDeps).toHaveLength(2); // both edges
  });
});

describe('per-user model allow-list enforcement', () => {
  it('blocks a restricted user from spawning a disallowed (but globally-allowed) exec', async () => {
    const { app, adminTok, bobTok, bob, userProjects, tasks, tmux } = setup();
    userProjects.assign(bob.id, 1);                                  // bob can reach the project surface
    await app.request(`/users/${bob.id}`, patch(adminTok, { allowed_execs: ['sonnet'] }));
    tasks.create({ id: 'orca-1', project_id: 1, title: 'X' });

    // 'ollama-cloud/deepseek-v4-flash' is in the GLOBAL allow-list but not in bob's → 403, no spawn.
    const blocked = await app.request('/sessions', post(bobTok, { taskId: 'orca-1', exec: 'ollama-cloud/deepseek-v4-flash' }));
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
    expect((await app.request('/sessions', post(bobTok, { taskId: 'orca-1', exec: 'ollama-cloud/deepseek-v4-flash' }))).status).toBe(201);
    tasks.setStatus('orca-1', 'closed'); // free the shared checkout before the next launch (single-writer)
    tasks.create({ id: 'orca-2', project_id: 1, title: 'Y' });
    expect((await app.request('/sessions', post(adminTok, { taskId: 'orca-2', exec: 'codex:gpt-5.5' }))).status).toBe(201);
  });
});

describe('admin gates & input validation (batch 1 audit fixes)', () => {
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
    const disengage = vi.fn().mockResolvedValue(undefined);
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const { app, adminTok, tasks, db } = setup({ engine: { disengage }, missionGit: { cleanup } });
    tasks.create({ id: 'orca-ep', project_id: 1, title: 'Epic', type: 'epic' });
    tasks.create({ id: 'orca-c1', project_id: 1, title: 'C1', parent_id: 'orca-ep' });
    tasks.create({ id: 'orca-c2', project_id: 1, title: 'C2', parent_id: 'orca-ep' });
    db.prepare("INSERT INTO missions (id,epic_id,autonomy,state) VALUES ('m-orca-ep','orca-ep','L3','active')").run();
    tasks.create({ id: 'orca-keep', project_id: 1, title: 'Keep' });

    const res = await app.request('/tasks/orca-ep?subtree=1', { method: 'DELETE', headers: { authorization: `Bearer ${adminTok}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, tasks: 3 });
    expect(disengage).toHaveBeenCalledWith('m-orca-ep'); // running mission stopped
    expect(cleanup).toHaveBeenCalledWith('m-orca-ep');   // worktree freed
    expect(tasks.get('orca-ep')).toBeNull();
    expect(tasks.get('orca-c1')).toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM missions').get()).toEqual({ c: 0 });
    expect(tasks.get('orca-keep')).not.toBeNull();
  });

  it('DELETE /tasks/:id?subtree=1 frees the worktree even when the mission already completed (disengaged)', async () => {
    // A naturally-completed mission keeps its worktree for the PR/feedback path, so it sits in
    // 'disengaged' — not 'live'. Deleting the epic must still tear down the worktree + its mission_pr
    // row, or both leak. disengage() is skipped (nothing is running); cleanup() runs unconditionally.
    const disengage = vi.fn().mockResolvedValue(undefined);
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const { app, adminTok, tasks, db } = setup({ engine: { disengage }, missionGit: { cleanup } });
    tasks.create({ id: 'orca-ep', project_id: 1, title: 'Epic', type: 'epic' });
    db.prepare("INSERT INTO missions (id,epic_id,autonomy,state) VALUES ('m-orca-ep','orca-ep','L3','disengaged')").run();
    db.prepare("INSERT INTO mission_pr (mission_id,branch,worktree) VALUES ('m-orca-ep','orca/x','/wt')").run();

    const res = await app.request('/tasks/orca-ep?subtree=1', { method: 'DELETE', headers: { authorization: `Bearer ${adminTok}` } });
    expect(res.status).toBe(200);
    expect(disengage).not.toHaveBeenCalled();          // already disengaged — nothing to stop
    expect(cleanup).toHaveBeenCalledWith('m-orca-ep'); // but the worktree is still freed
    expect(db.prepare('SELECT COUNT(*) c FROM mission_pr').get()).toEqual({ c: 0 }); // cascade pruned the row
  });
});
