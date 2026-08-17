import { describe, it, expect } from 'vitest';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';
import { RefAdvisorHooks, RefMissions, RefReadiness, RefTaskStore } from '../helpers/refStores.js';

/** Server wired with the reference advisor hooks (refStores.ts, over a fake tmux) plus a brain stub
 *  that records how much of the user's durable state is still visible at the moment live teardown runs
 *  — that ordering is the whole point of the delete route. The advisor SERVICE is plugin-owned; what
 *  the daemon owns, and what is measured here, is calling its two hooks before the row is gone. */
function setup() {
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw'); // first user → is_admin
  const carol = users.create('carol', 'pw');
  const config = new ConfigStore(db);
  const tmux = new FakeTmuxDriver();
  const advisor = new RefAdvisorHooks(tmux, users);
  /** Terminal bindings still resolvable when deleteAllManagedSessions was invoked (-1 = never invoked). */
  let bindingsAtTeardown = -1;
  const brain = {
    deleteAllManagedSessions: (userId: number): number => {
      bindingsAtTeardown = (db.prepare('SELECT COUNT(*) c FROM brain_terminals WHERE user_id = ?').get(userId) as { c: number }).c;
      return 0;
    },
  };
  const app = createServer({
    tasks: new RefTaskStore(db), readiness: new RefReadiness(db), missions: new RefMissions(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: tmux as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
    advisor, brain: brain as never,
  });
  return { app, db, users, tmux, carol, advisor, adminTok: users.issueToken(admin.id), bindings: () => bindingsAtTeardown };
}
const del = (t: string) => ({ method: 'DELETE', headers: { authorization: `Bearer ${t}` } });
const post = (t: string, body: unknown) => ({ method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('DELETE /users/:id tears down what is running before it deletes what is stored', () => {
  it('kills the deleted user\'s advisor tmux instead of orphaning it', async () => {
    const { app, tmux, carol, advisor, adminTok } = setup();
    const session = RefAdvisorHooks.session(carol.id);
    tmux.setPane(session, ''); // carol's advisor is live — a full agent CLI with shell access
    expect(await tmux.list()).toContain(session);

    expect((await app.request(`/users/${carol.id}`, del(adminTok))).status).toBe(200);
    expect(await tmux.list()).not.toContain(session); // nothing else ever reaps this session
    // …and the hook ran while the row was still there: stop() persists advisor_autostart=false, which
    // is a no-op against a deleted user, so calling it after the delete would silently do nothing.
    expect(advisor.stoppedAfterDelete).toEqual([]);
  });

  it('runs brain-session teardown while the user\'s brain_terminals bindings still exist', async () => {
    const { app, db, carol, adminTok, bindings } = setup();
    db.prepare("INSERT INTO brain_terminals (terminal_name, user_id, brain_session_id, token) VALUES ('elowen-chat-x', ?, 'brain-1', 'tok')").run(carol.id);

    expect((await app.request(`/users/${carol.id}`, del(adminTok))).status).toBe(200);
    // The teardown resolves each conversation's binding to kill its tmux and revoke its token; running
    // it after users.delete() wiped brain_terminals would leave the terminal alive.
    expect(bindings()).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM brain_terminals WHERE user_id = ?').get(carol.id)).toEqual({ c: 0 });
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
    // An IP address is personal data: deleting the account must delete it, not leave it for the next
    // retention sweep — and certainly not leave it for a recycled user id to inherit.
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
    // projects.id is a plain rowid, so id 42 can later be handed to a real project — which would have
    // inherited this grant without any approval.
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
