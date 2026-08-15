import { describe, it, expect, vi } from 'vitest';
import { TaskRefs } from '../../src/store/taskRefs.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';
import { RefMissions, RefTaskStore } from '../helpers/refStores.js';

/** The daemon's OWN permission surface: /users management, impersonation, and the admin cleanup wipe.
 *
 *  The task domain is the reference store (refStores.ts) over the frozen plugin tables, which is exactly
 *  what the cleanup route needs — it counts and purges rows, it does not serve them. The permission rules
 *  observed through a PLUGIN-served route (task-dep tenancy, the exec allow-list at spawn, mission and
 *  session teardown) moved with those routes to the plugin registry:
 *  tests/work-userPermissions.test.ts there. */
async function setup(extra: { missionGit?: unknown } = {}) {
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw'); // first user -> is_admin
  const bob = users.create('bob', 'pw');
  const userProjects = new UserProjectStore(db);
  const tasks = new RefTaskStore(db);
  const tmux = new FakeTmuxDriver();
  const app = createServer({
    tasks, taskRefs: new TaskRefs(db), missions: new RefMissions(db), bus: new EventBus(),
    engine: { disengage: async () => {} } as never, tmux,
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

describe('POST /admin/cleanup — the daemon-owned operational wipe', () => {
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

  it('POST /admin/cleanup frees a paused mission\'s worktree even though it is not "live"', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const { app, adminTok, tasks, db } = await setup({ missionGit: { cleanup } });
    tasks.create({ id: 'elowen-paused-ep', project_id: 1, title: 'Epic', type: 'epic' });
    // 'paused' is not in RefMissions.live() ('active'/'stalled' only), so the disengage sweep never
    // reaches it — but it still holds a worktree (pause keeps it for resume). cleanup() must still run.
    db.prepare("INSERT INTO missions (id,epic_id,autonomy,state) VALUES ('m-elowen-paused-ep','elowen-paused-ep','L3','paused')").run();

    const res = await app.request('/admin/cleanup', post(adminTok, {}));
    expect(res.status).toBe(200);
    expect(cleanup).toHaveBeenCalledWith('m-elowen-paused-ep');
  });
});
