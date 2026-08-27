import { describe, it, expect } from 'vitest';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';

function setup(
  onUserRemoved?: (userId: number) => void | Promise<void>,
  killAccountProcesses?: (userId: number) => Promise<number>,
) {
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw'); // first user → is_admin
  const carol = users.create('carol', 'pw');
  const config = new ConfigStore(db);
  /** The user's own rows still present when deleteAllManagedSessions was invoked (-1 = never invoked).
   *  `user_prompts` stands in for "the user's stored data": it is wiped by users.delete(), so seeing it
   *  still there proves the teardown ran BEFORE the delete, which is the order under test. */
  let bindingsAtTeardown = -1;
  const brain = {
    deleteAllManagedSessions: (userId: number): number => {
      bindingsAtTeardown = (db.prepare('SELECT COUNT(*) c FROM user_prompts WHERE user_id = ?').get(userId) as { c: number }).c;
      return 0;
    },
  };
  const app = createServer({
    bus: new EventBus(), project: { id: 1, path: '/o' }, clock: new FakeClock(0), config,
    users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db), brain: brain as never,
    plugins: onUserRemoved ? {
      get: async () => ({ userRemovedHandlers: [{ plugin: 'fixture', fn: onUserRemoved }] }),
    } as never : undefined,
    killAccountProcesses,
  });
  return { app, db, users, carol, adminTok: users.issueToken(admin.id), bindings: () => bindingsAtTeardown };
}
const del = (t: string) => ({ method: 'DELETE', headers: { authorization: `Bearer ${t}` } });
const post = (t: string, body: unknown) => ({ method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('DELETE /users/:id tears down what is running before it deletes what is stored', () => {
  it('runs brain-session teardown while the user\'s own rows still exist', async () => {
    const { app, db, carol, adminTok, bindings } = setup();
    db.prepare("INSERT INTO user_prompts (user_id, name, content) VALUES (?, 'p', 'b')").run(carol.id);

    expect((await app.request(`/users/${carol.id}`, del(adminTok))).status).toBe(200);
    expect(bindings()).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM user_prompts WHERE user_id = ?').get(carol.id)).toEqual({ c: 0 });
  });

  it('runs loaded plugin cleanup while the user row still exists', async () => {
    let existedAtCleanup = false;
    const { app, db, carol, adminTok } = setup((userId) => {
      existedAtCleanup = db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId) !== undefined;
      db.prepare('DELETE FROM tasks WHERE created_by = ?').run(userId);
    });
    db.prepare("INSERT INTO tasks (id, project_id, title, type, created_by) VALUES ('owned', 1, 'Owned', 'task', ?)").run(carol.id);

    expect((await app.request(`/users/${carol.id}`, del(adminTok))).status).toBe(200);
    expect(existedAtCleanup).toBe(true);
    expect(db.prepare("SELECT COUNT(*) c FROM tasks WHERE id = 'owned'").get()).toEqual({ c: 0 });
  });

  it('signals daemon and runner process owners before plugin cleanup', async () => {
    const order: string[] = [];
    const { app, carol, adminTok } = setup(
      () => { order.push('plugin'); },
      async () => { order.push('processes'); return 2; },
    );

    expect((await app.request(`/users/${carol.id}`, del(adminTok))).status).toBe(200);
    expect(order).toEqual(['processes', 'plugin']);
  });

  it('returns 409 and preserves the user when process teardown cannot be verified', async () => {
    const { app, users, carol, adminTok } = setup(undefined, async () => { throw new Error('runner timeout'); });

    expect((await app.request(`/users/${carol.id}`, del(adminTok))).status).toBe(409);
    expect(users.get(carol.id)).not.toBeNull();
  });

  it('returns 409 and preserves the user while a plugin reports an active durable lease', async () => {
    const active = Object.assign(new Error('active lease'), { status: 409, code: 'account_in_use' });
    const { app, users, carol, adminTok } = setup(() => { throw active; }, async () => 1);

    expect((await app.request(`/users/${carol.id}`, del(adminTok))).status).toBe(409);
    expect(users.get(carol.id)).not.toBeNull();
  });

  it('leaves retired plugin rows untouched without a loaded cleanup handler', async () => {
    const { app, db, carol, adminTok } = setup();
    db.prepare("INSERT INTO tasks (id, project_id, title, type, created_by) VALUES ('orphan', 1, 'Orphan', 'task', ?)").run(carol.id);

    expect((await app.request(`/users/${carol.id}`, del(adminTok))).status).toBe(200);
    expect(db.prepare("SELECT created_by FROM tasks WHERE id = 'orphan'").get()).toEqual({ created_by: carol.id });
  });

  it('still removes the user and their assignments', async () => {
    const { app, db, users, carol, adminTok } = setup();
    db.prepare('INSERT INTO user_projects (user_id, project_id) VALUES (?, 1)').run(carol.id);

    expect((await app.request(`/users/${carol.id}`, del(adminTok))).status).toBe(200);
    expect(users.get(carol.id)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM user_projects WHERE user_id = ?').get(carol.id)).toEqual({ c: 0 });
  });

  it('takes the user\'s recorded IP addresses with them', async () => {
    const { app, db, carol, adminTok } = setup();
    db.prepare(`INSERT INTO usage_by_origin (day, user_id, origin, origin_kind, trusted, turns, total, first_at, last_at)
                VALUES ('2026-08-17', ?, '203.0.113.7', 'ip', 1, 1, 100, 1, 1)`).run(carol.id);
    db.prepare(`INSERT INTO brain_session_origins (session_id, origin, user_id, trusted, requests, first_at, last_at)
                VALUES ('brain-1', '203.0.113.7', ?, 1, 1, 1, 1)`).run(carol.id);

    expect((await app.request(`/users/${carol.id}`, del(adminTok))).status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) c FROM usage_by_origin WHERE user_id = ?').get(carol.id)).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM brain_session_origins WHERE user_id = ?').get(carol.id)).toEqual({ c: 0 });
  });
});

describe('POST /users/:id/projects requires both sides to exist', () => {
  it('404s on an unknown project instead of pre-granting access to a not-yet-created one', async () => {
    const { app, db, carol, adminTok } = setup();
    const res = await app.request(`/users/${carol.id}/projects`, post(adminTok, { projectId: 42 }));
    expect(res.status).toBe(404);
    expect(db.prepare('SELECT COUNT(*) c FROM user_projects WHERE user_id = ?').get(carol.id)).toEqual({ c: 0 });
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (42,'later','/l')").run();
    expect((await app.request(`/users/${carol.id}/projects`, post(adminTok, { projectId: 42 }))).status).toBe(200);
  });

  it('404s on an unknown user', async () => {
    const { app, db, adminTok } = setup();
    expect((await app.request('/users/999/projects', post(adminTok, { projectId: 1 }))).status).toBe(404);
    expect(db.prepare('SELECT COUNT(*) c FROM user_projects').get()).toEqual({ c: 0 });
  });

  it('accepts a valid pair', async () => {
    const { app, carol, adminTok } = setup();
    expect((await app.request(`/users/${carol.id}/projects`, post(adminTok, { projectId: 1 }))).status).toBe(200);
    const listed = await (await app.request(`/users/${carol.id}/projects`, { headers: { authorization: `Bearer ${adminTok}` } })).json();
    expect(listed).toEqual([1]);
  });
});
