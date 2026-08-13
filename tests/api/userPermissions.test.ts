import { describe, it, expect, vi } from 'vitest';
import { render } from '../../src/prompts/index.js';
const promptSeam = { render: (n: string, v?: Record<string, string>) => render(n, v), rawTemplate: () => '' };
import { TaskRefs } from '../../src/store/taskRefs.js';
import { TaskStore } from '../../plugins/work/src/store/taskStore.js';
import { Readiness } from '../../plugins/work/src/store/readiness.js';
import { MissionStore } from '../../plugins/agents/src/store/missionStore.js';
import { AgentStore } from '../../plugins/agents/src/store/agentStore.js';
import { SpawnService } from '../../plugins/agents/src/spawn/spawn.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { agentsPluginProvider } from '../helpers/testApp.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';

async function setup(extra: { engine?: unknown; missionGit?: unknown } = {}) {
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw'); // first user → is_admin
  const bob = users.create('bob', 'pw');
  const userProjects = new UserProjectStore(db);
  const tasks = new TaskStore(db);
  const tmux = new FakeTmuxDriver();
  const readiness = new Readiness(db);
  const config = new ConfigStore(db);
  const projects = new ProjectStore(db);
  // The /missions surface — and the whole /tasks surface — is served by the plugins' root-mounted
  // routes now.
  const provider = agentsPluginProvider({ db, tasks, readiness, config, projects, users, tmux });
  const app = createServer({
    tasks, taskRefs: new TaskRefs(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: (extra.engine ?? { disengage: async () => {} }) as never, spawn: new SpawnService({ prompts: promptSeam, tmux, agents: new AgentStore(db) }), tmux,
    missionGit: extra.missionGit as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config,
    users, projects, userProjects,
    plugins: provider,
  });
  // The task routes reach mission teardown through the LIVE agents control, not through ServerDeps —
  // so a test's engine/missionGit doubles have to be patched onto the very instances the registry
  // hands those routes (own-property assignment over the class method), keeping the core-facing deps
  // above (admin cleanup) in sync.
  const control = (await provider.get()).control('agents');
  if (!control) throw new Error('agents plugin failed to load in setup()');
  const engineDouble = extra.engine as { disengage?: (id: string) => Promise<void> } | undefined;
  if (engineDouble?.disengage) (control.engine() as { disengage: (id: string) => Promise<void> }).disengage = engineDouble.disengage;
  const missionGitDouble = extra.missionGit as { cleanup?: (id: string) => Promise<void> } | undefined;
  if (missionGitDouble?.cleanup) (control.missionGit() as { cleanup: (id: string) => Promise<void> }).cleanup = missionGitDouble.cleanup;
  return { app, db, users, userProjects, tasks, tmux, admin, bob, adminTok: users.issueToken(admin.id), bobTok: users.issueToken(bob.id) };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const patch = (t: string, body: unknown) => ({ method: 'PATCH', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const post = (t: string, body: unknown) => ({ method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const del = (t: string) => ({ method: 'DELETE', headers: { authorization: `Bearer ${t}` } });

describe('PATCH /users/:id — admin manages permissions', () => {
  it('admin grants the admin role to another user', async () => {
    const { app, adminTok, bob } = await setup();
    const res = await app.request(`/users/${bob.id}`, patch(adminTok, { is_admin: true }));
    expect(res.status).toBe(200);
    expect((await res.json()).is_admin).toBe(true);
  });

  it('admin sets a per-user model allow-list, filtered to the global allow-list', async () => {
    const { app, adminTok, bob } = await setup();
    // 'sonnet' is globally allowed; 'bogus/model' is not → dropped.
    const res = await app.request(`/users/${bob.id}`, patch(adminTok, { allowed_execs: ['sonnet', 'bogus/model'] }));
    expect(res.status).toBe(200);
    expect((await res.json()).allowed_execs).toEqual(['sonnet']);
  });

  it('a non-admin cannot edit anyone (403)', async () => {
    const { app, bobTok, bob } = await setup();
    expect((await app.request(`/users/${bob.id}`, patch(bobTok, { allowed_execs: ['sonnet'] }))).status).toBe(403);
  });

  it('refuses to demote the last admin', async () => {
    const { app, adminTok, admin } = await setup();
    expect((await app.request(`/users/${admin.id}`, patch(adminTok, { is_admin: false }))).status).toBe(400);
  });

  it('404 for an unknown user', async () => {
    const { app, adminTok } = await setup();
    expect((await app.request('/users/999', patch(adminTok, { is_admin: true }))).status).toBe(404);
  });
});

describe('RBAC tightening — /users directory & deletion are admin-only', () => {
  it('GET /users is admin-only (non-admin → 403, admin → roster)', async () => {
    const { app, adminTok, bobTok } = await setup();
    expect((await app.request('/users', auth(bobTok))).status).toBe(403);
    const ok = await app.request('/users', auth(adminTok));
    expect(ok.status).toBe(200);
    expect((await ok.json()).length).toBe(2);
  });

  it('DELETE /users/:id is admin-only — a non-admin cannot delete another user', async () => {
    const { app, adminTok, bobTok, users } = await setup();
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
    const { app, adminTok, bobTok, admin, bob } = await setup();
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
    const { app, bobTok, userProjects, tasks, db, bob } = await setup();
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'other','/x')").run();
    userProjects.assign(bob.id, 1); // clears the home-project middleware gate, but NOT project 2
    tasks.create({ id: 'elowen-p2', project_id: 2, title: 'Foreign' });
    expect((await app.request('/tasks/elowen-p2/deps', auth(bobTok))).status).toBe(403);
    expect((await app.request('/tasks/nope/deps', auth(bobTok))).status).toBe(404);
  });

  it('a non-admin assigned only to a NON-home project passes the coarse gate and sees just that project', async () => {
    const { app, bobTok, userProjects, tasks, db, bob } = await setup();
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'sarah','/s')").run();
    userProjects.assign(bob.id, 2); // assigned to project 2 only — NOT the daemon's home project (1)
    tasks.create({ id: 'elowen-home', project_id: 1, title: 'Home' });
    tasks.create({ id: 'elowen-sarah', project_id: 2, title: 'Sarah' });
    const res = await app.request('/tasks', auth(bobTok));
    expect(res.status).toBe(200); // the gate no longer keys on the home project
    expect((await res.json()).map((t: { id: string }) => t.id)).toEqual(['elowen-sarah']); // scoped to project 2
  });

  it('GET /tasks/deps only returns edges for accessible projects (admin sees all)', async () => {
    const { app, adminTok, bobTok, userProjects, tasks, db, bob } = await setup();
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'other','/x')").run();
    userProjects.assign(bob.id, 1);
    tasks.create({ id: 'elowen-a', project_id: 1, title: 'A' });
    tasks.create({ id: 'elowen-b', project_id: 1, title: 'B' });
    tasks.setDeps('elowen-b', ['elowen-a']); // edge inside project 1
    tasks.create({ id: 'elowen-x', project_id: 2, title: 'X' });
    tasks.create({ id: 'elowen-y', project_id: 2, title: 'Y' });
    tasks.setDeps('elowen-y', ['elowen-x']); // edge inside project 2

    const bobDeps = await (await app.request('/tasks/deps', auth(bobTok))).json();
    expect(bobDeps).toEqual([{ task_id: 'elowen-b', depends_on_id: 'elowen-a' }]); // only project 1
    const adminDeps = await (await app.request('/tasks/deps', auth(adminTok))).json();
    expect(adminDeps).toHaveLength(2); // both edges
  });
});

describe('per-user model allow-list enforcement', () => {
  it('blocks a restricted user from spawning a disallowed (but globally-allowed) exec', async () => {
    const { app, adminTok, bobTok, bob, userProjects, tasks, tmux } = await setup();
    userProjects.assign(bob.id, 1);                                  // bob can reach the project surface
    await app.request(`/users/${bob.id}`, patch(adminTok, { allowed_execs: ['sonnet'] }));
    tasks.create({ id: 'elowen-1', project_id: 1, title: 'X' });

    // 'ollama-cloud/deepseek-v4-flash' is in the GLOBAL allow-list but not in bob's → 403, no spawn.
    const blocked = await app.request('/sessions', post(bobTok, { taskId: 'elowen-1', exec: 'ollama-cloud/deepseek-v4-flash' }));
    expect(blocked.status).toBe(403);
    expect(await tmux.list()).toHaveLength(0);

    // 'sonnet' is in bob's list → allowed.
    const ok = await app.request('/sessions', post(bobTok, { taskId: 'elowen-1', exec: 'sonnet' }));
    expect(ok.status).toBe(201);
  });

  it('an empty allow-list imposes no per-user restriction, and the admin is unrestricted', async () => {
    const { app, adminTok, bobTok, bob, userProjects, tasks } = await setup();
    userProjects.assign(bob.id, 1);
    tasks.create({ id: 'elowen-1', project_id: 1, title: 'X' });
    // bob has no allowed_execs set → any globally-allowed exec works.
    expect((await app.request('/sessions', post(bobTok, { taskId: 'elowen-1', exec: 'ollama-cloud/deepseek-v4-flash' }))).status).toBe(201);
    tasks.setStatus('elowen-1', 'closed'); // free the shared checkout before the next launch (single-writer)
    tasks.create({ id: 'elowen-2', project_id: 1, title: 'Y' });
    expect((await app.request('/sessions', post(adminTok, { taskId: 'elowen-2', exec: 'codex:gpt-5.5' }))).status).toBe(201);
  });
});

describe('admin gates & input validation (batch 1 audit fixes)', () => {
  it('POST /missions rejects a missing epicId (400) and an unknown epic (404) before touching the engine', async () => {
    const { app, adminTok } = await setup();
    expect((await app.request('/missions', post(adminTok, {}))).status).toBe(400);
    expect((await app.request('/missions', post(adminTok, { epicId: 'nope' }))).status).toBe(404);
  });

  it('POST /sessions/:name/keys rejects non-array / flag-injection keys (400)', async () => {
    const { app, adminTok } = await setup();
    expect((await app.request('/sessions/elowen-Nova/keys', post(adminTok, { keys: 'Enter' }))).status).toBe(400);
    expect((await app.request('/sessions/elowen-Nova/keys', post(adminTok, { keys: [] }))).status).toBe(400);
    expect((await app.request('/sessions/elowen-Nova/keys', post(adminTok, { keys: ['-t', 'other', 'C-c'] }))).status).toBe(400);
    // a clean key list is accepted
    expect((await app.request('/sessions/elowen-Nova/keys', post(adminTok, { keys: ['Enter'] }))).status).toBe(200);
  });

  it('POST /admin/cleanup is admin-only and wipes all tasks + missions', async () => {
    const { app, adminTok, bobTok, tasks, db } = await setup();
    tasks.create({ id: 'elowen-1', project_id: 1, title: 'X' });
    tasks.create({ id: 'elowen-2', project_id: 1, title: 'Y', type: 'epic' });
    db.prepare("INSERT INTO missions (id,epic_id,autonomy,state) VALUES ('m1','elowen-2','L3','active')").run();
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
    const { app, adminTok, tasks, db } = await setup({ engine: { disengage }, missionGit: { cleanup } });
    tasks.create({ id: 'elowen-ep', project_id: 1, title: 'Epic', type: 'epic' });
    tasks.create({ id: 'elowen-c1', project_id: 1, title: 'C1', parent_id: 'elowen-ep' });
    tasks.create({ id: 'elowen-c2', project_id: 1, title: 'C2', parent_id: 'elowen-ep' });
    db.prepare("INSERT INTO missions (id,epic_id,autonomy,state) VALUES ('m-elowen-ep','elowen-ep','L3','active')").run();
    tasks.create({ id: 'elowen-keep', project_id: 1, title: 'Keep' });

    const res = await app.request('/tasks/elowen-ep?subtree=1', { method: 'DELETE', headers: { authorization: `Bearer ${adminTok}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, tasks: 3 });
    expect(disengage).toHaveBeenCalledWith('m-elowen-ep'); // running mission stopped
    expect(cleanup).toHaveBeenCalledWith('m-elowen-ep');   // worktree freed
    expect(tasks.get('elowen-ep')).toBeNull();
    expect(tasks.get('elowen-c1')).toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM missions').get()).toEqual({ c: 0 });
    expect(tasks.get('elowen-keep')).not.toBeNull();
  });

  it('DELETE /tasks/:id?subtree=1 frees the worktree even when the mission already completed (disengaged)', async () => {
    // A naturally-completed mission keeps its worktree for the PR/feedback path, so it sits in
    // 'disengaged' — not 'live'. Deleting the epic must still tear down the worktree + its mission_pr
    // row, or both leak. disengage() is skipped (nothing is running); cleanup() runs unconditionally.
    const disengage = vi.fn().mockResolvedValue(undefined);
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const { app, adminTok, tasks, db } = await setup({ engine: { disengage }, missionGit: { cleanup } });
    tasks.create({ id: 'elowen-ep', project_id: 1, title: 'Epic', type: 'epic' });
    db.prepare("INSERT INTO missions (id,epic_id,autonomy,state) VALUES ('m-elowen-ep','elowen-ep','L3','disengaged')").run();
    db.prepare("INSERT INTO mission_pr (mission_id,branch,worktree) VALUES ('m-elowen-ep','elowen/x','/wt')").run();

    const res = await app.request('/tasks/elowen-ep?subtree=1', { method: 'DELETE', headers: { authorization: `Bearer ${adminTok}` } });
    expect(res.status).toBe(200);
    expect(disengage).not.toHaveBeenCalled();          // already disengaged — nothing to stop
    expect(cleanup).toHaveBeenCalledWith('m-elowen-ep'); // but the worktree is still freed
    expect(db.prepare('SELECT COUNT(*) c FROM mission_pr').get()).toEqual({ c: 0 }); // cascade pruned the row
  });

  it('DELETE /tasks/:id removes an epic\'s mission WITHOUT the ?subtree=1 flag — decided by the task\'s real type', async () => {
    const disengage = vi.fn().mockResolvedValue(undefined);
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const { app, adminTok, tasks, db } = await setup({ engine: { disengage }, missionGit: { cleanup } });
    tasks.create({ id: 'elowen-ep2', project_id: 1, title: 'Epic', type: 'epic' });
    tasks.create({ id: 'elowen-c3', project_id: 1, title: 'C3', parent_id: 'elowen-ep2' });
    db.prepare("INSERT INTO missions (id,epic_id,autonomy,state) VALUES ('m-elowen-ep2','elowen-ep2','L3','active')").run();

    // Deliberately no ?subtree=1 — a plain delete of an epic must still disengage its mission and free
    // its worktree BEFORE the rows disappear, not just remove the mission row from the DB.
    const res = await app.request('/tasks/elowen-ep2', { method: 'DELETE', headers: { authorization: `Bearer ${adminTok}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, tasks: 2 });
    expect(disengage).toHaveBeenCalledWith('m-elowen-ep2');
    expect(cleanup).toHaveBeenCalledWith('m-elowen-ep2');
    expect(tasks.get('elowen-ep2')).toBeNull();
    expect(tasks.get('elowen-c3')).toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM missions').get()).toEqual({ c: 0 });
  });

  it('DELETE /tasks/:id stops a running leaf task\'s own tmux session before removing the row', async () => {
    const { app, adminTok, tasks, tmux } = await setup();
    tasks.create({ id: 'elowen-leaf', project_id: 1, title: 'Leaf', labels: ['agent:Nova'] });
    tasks.setStatus('elowen-leaf', 'in_progress');
    tmux.setPane('elowen-Nova', ''); // simulate the live agent session

    const res = await app.request('/tasks/elowen-leaf', { method: 'DELETE', headers: { authorization: `Bearer ${adminTok}` } });
    expect(res.status).toBe(200);
    expect(await tmux.list()).not.toContain('elowen-Nova'); // its agent was stopped, not orphaned
    expect(tasks.get('elowen-leaf')).toBeNull();
  });

  it('POST /admin/cleanup frees a paused mission\'s worktree even though it is not "live"', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const { app, adminTok, tasks, db } = await setup({ missionGit: { cleanup } });
    tasks.create({ id: 'elowen-paused-ep', project_id: 1, title: 'Epic', type: 'epic' });
    // 'paused' is not in MissionStore.live() ('active'/'stalled' only), so the disengage sweep never
    // reaches it — but it still holds a worktree (pause keeps it for resume). cleanup() must still run.
    db.prepare("INSERT INTO missions (id,epic_id,autonomy,state) VALUES ('m-elowen-paused-ep','elowen-paused-ep','L3','paused')").run();

    const res = await app.request('/admin/cleanup', post(adminTok, {}));
    expect(res.status).toBe(200);
    expect(cleanup).toHaveBeenCalledWith('m-elowen-paused-ep');
  });

  it('PATCH /tasks/:id addDep 400s on a dangling or cross-project edge, applies a valid one', async () => {
    const { app, adminTok, tasks, db } = await setup();
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'other','/o2')").run();
    tasks.create({ id: 'elowen-a', project_id: 1, title: 'A' });
    tasks.create({ id: 'elowen-b', project_id: 1, title: 'B' });
    tasks.create({ id: 'elowen-foreign', project_id: 2, title: 'Foreign' });

    const dangling = await app.request('/tasks/elowen-a', patch(adminTok, { addDep: 'nope' }));
    expect(dangling.status).toBe(400);
    const cross = await app.request('/tasks/elowen-a', patch(adminTok, { addDep: 'elowen-foreign' }));
    expect(cross.status).toBe(400);
    expect(tasks.depsFor('elowen-a')).toEqual([]);

    const ok = await app.request('/tasks/elowen-a', patch(adminTok, { addDep: 'elowen-b' }));
    expect(ok.status).toBe(200);
    expect(tasks.depsFor('elowen-a')).toEqual(['elowen-b']);
  });
});
