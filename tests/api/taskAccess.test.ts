import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
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
import { agentsPluginProvider } from '../helpers/testApp.js';

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
  const readiness = new Readiness(db);
  const config = new ConfigStore(db);
  const projects = new ProjectStore(db);
  const app = createServer({
    tasks, readiness, missions, bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config,
    users, projects, userProjects,
    // The /missions surface is served by the agents plugin's root-mounted routes now.
    plugins: agentsPluginProvider({ db, tasks, readiness, config, projects, users }),
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

  it('gates the executor on PATCH /tasks/:id so an off-allow-list exec cannot become a shell-injection foothold', async () => {
    const { app, adminTok } = setup();
    // An injection payload is not a known exec → the global allow-list refuses it (400), so it never
    // lands as an `exec:` label that the launch command would interpolate into the shell.
    expect((await app.request('/tasks/t1', patch(adminTok, { exec: 'sonnet; touch /tmp/pwned #' }))).status).toBe(400);
    // A legitimate, allow-listed exec is still accepted, and a blank value clears the override.
    expect((await app.request('/tasks/t1', patch(adminTok, { exec: 'sonnet' }))).status).toBe(200);
    expect((await app.request('/tasks/t1', patch(adminTok, { exec: '' }))).status).toBe(200);
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

  // resolveTarget() used to return the home project (and its data) without ever calling
  // canAccessProject(), so a caller confined elsewhere could still create tasks/plans in it — the
  // original version of this test masked exactly this by assigning its second user to the home
  // project. Here Carol is a member of project 2 ONLY, never of the home project (1).
  it('a non-admin not assigned to the home project cannot POST /tasks or /tasks/plan into it', async () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'home','/o')").run();
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'other','/p2')").run();
    const users = new UserStore(db);
    users.create('admin', 'pw');
    const carol = users.create('carol', 'pw');
    const userProjects = new UserProjectStore(db);
    userProjects.assign(carol.id, 2); // carol can reach project 2 — never the home project (1)
    const tasks = new TaskStore(db);
    const app = createServer({
      tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
      engine: null as never, spawn: null as never, tmux: null as never,
      project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
      clock: new FakeClock(0), config: new ConfigStore(db),
      users, projects: new ProjectStore(db), userProjects,
    });
    const carolTok = users.issueToken(carol.id);
    // No project_id → defaults to the home project (1); carol has no access to it.
    const createRes = await app.request('/tasks', {
      method: 'POST', headers: { authorization: `Bearer ${carolTok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'sneaky home task' }),
    });
    expect(createRes.status).toBe(403);
    expect(tasks.list().length).toBe(0); // never created

    const planRes = await app.request('/tasks/plan', {
      method: 'POST', headers: { authorization: `Bearer ${carolTok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'sneaky home plan' }),
    });
    expect(planRes.status).toBe(403);
  });

  // Same bypass, but for an agent-scoped token: canAccessProject documents agent confinement as
  // "never admin-bypass", and resolveTarget's home-project early return skipped that too. An
  // agent token with an empty working set (no live agent task/mission) must be refused the home
  // project exactly like any other project it hasn't been confined to.
  it('an agent-scoped token outside its working set cannot POST /tasks into the home project', async () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'home','/o')").run();
    const users = new UserStore(db);
    const admin = users.create('admin', 'pw');
    const userProjects = new UserProjectStore(db); // multi-tenant mode → agent tokens are gated by working set
    const tasks = new TaskStore(db);
    const app = createServer({
      tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
      engine: null as never, spawn: null as never, tmux: null as never,
      project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
      clock: new FakeClock(0), config: new ConfigStore(db),
      users, projects: new ProjectStore(db), userProjects,
    });
    const agentTok = users.issueToken(admin.id, 'agent'); // nothing in_progress/active → empty working set
    const res = await app.request('/tasks', {
      method: 'POST', headers: { authorization: `Bearer ${agentTok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'sneaky agent home task' }),
    });
    expect(res.status).toBe(403);
    expect(tasks.list().length).toBe(0);
  });

  // The final-phase agent closes the epic itself right after closing its own leaf. By then its task is
  // no longer in_progress and the mission has disengaged, so the agent's working set (in_progress agent
  // tasks + active missions' epics) is empty — its epic-close would 403. The still-open epic, having
  // hosted agent work, must keep its project reachable to that agent until the epic itself is closed.
  it('an agent can close its own (still-open) mission epic after its final leaf closed — no 403 race', async () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'home','/o')").run();
    const users = new UserStore(db);
    const admin = users.create('admin', 'pw');
    const userProjects = new UserProjectStore(db); // multi-tenant mode → agent tokens are gated by working set
    const tasks = new TaskStore(db);
    tasks.create({ id: 'epic1', project_id: 1, title: 'E1', type: 'epic' });
    tasks.create({ id: 'p1', project_id: 1, title: 'P1', parent_id: 'epic1' });
    tasks.setAgent('p1', 'Nova');     // the phase was worked by an agent…
    tasks.setStatus('p1', 'closed');  // …which already closed its own leaf (and the mission disengaged)
    const app = createServer({
      tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
      engine: null as never, spawn: null as never, tmux: null as never,
      project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
      clock: new FakeClock(0), config: new ConfigStore(db),
      users, projects: new ProjectStore(db), userProjects,
    });
    const agentTok = users.issueToken(admin.id, 'agent');
    const res = await app.request('/tasks/epic1', patch(agentTok, { status: 'closed', outcome: 'ok', result_summary: 'all phases done' }));
    expect(res.status).toBe(200);
    expect(tasks.get('epic1')!.status).toBe('closed');
  });
});
