import { describe, it, expect } from 'vitest';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { MissionStore } from '../../plugins/agents/src/store/missionStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { AdvisorService } from '../../plugins/agents/src/advisor/service.js';
import { openAgentsDb } from '../helpers/agentsDb.js';
import { advisorHostFor } from '../helpers/testApp.js';

/** Server wired with a real AdvisorService (fake tmux) plus a brain stub that records how much of the
 *  user's durable state is still visible at the moment live teardown runs — that ordering is the whole
 *  point of the delete route. */
function setup() {
  const db = openAgentsDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw'); // first user → is_admin
  const carol = users.create('carol', 'pw');
  const config = new ConfigStore(db);
  const tmux = new FakeTmuxDriver();
  // The plugin-owned advisor service (nothing spawns here — the delete route only needs stop()).
  const svc = new AdvisorService({
    spawn: () => undefined, tmux, host: advisorHostFor(users),
    config: config as never, prompts: { render: () => '', rawTemplate: () => '' },
    fallback: { program: 'claude-code', model: 'sonnet' },
    url: 'http://localhost:4400', mcpUrl: 'http://localhost:4400/mcp', prepareMcp: () => {},
  });
  const advisor = { ensureOnLogin: (id: number) => svc.ensureOnLogin(id), stop: (id: number) => svc.stop(id) };
  /** Terminal bindings still resolvable when deleteAllManagedSessions was invoked (-1 = never invoked). */
  let bindingsAtTeardown = -1;
  const brain = {
    deleteAllManagedSessions: (userId: number): number => {
      bindingsAtTeardown = (db.prepare('SELECT COUNT(*) c FROM brain_terminals WHERE user_id = ?').get(userId) as { c: number }).c;
      return 0;
    },
  };
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: tmux as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
    advisor, brain: brain as never,
  });
  return { app, db, users, tmux, carol, adminTok: users.issueToken(admin.id), bindings: () => bindingsAtTeardown };
}
const del = (t: string) => ({ method: 'DELETE', headers: { authorization: `Bearer ${t}` } });
const post = (t: string, body: unknown) => ({ method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('DELETE /users/:id tears down what is running before it deletes what is stored', () => {
  it('kills the deleted user\'s advisor tmux instead of orphaning it', async () => {
    const { app, tmux, carol, adminTok } = setup();
    const session = `elowen-advisor-${carol.id}`;
    tmux.setPane(session, ''); // carol's advisor is live — a full agent CLI with shell access
    expect(await tmux.list()).toContain(session);

    expect((await app.request(`/users/${carol.id}`, del(adminTok))).status).toBe(200);
    expect(await tmux.list()).not.toContain(session); // nothing else ever reaps this session
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
