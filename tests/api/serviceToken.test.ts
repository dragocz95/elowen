import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { MissionStore } from '../../src/store/missionStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { PlanJobStore } from '../../src/overseer/planJob.js';

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'other','/other')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw'); // first user → is_admin
  const planJobs = new PlanJobStore();
  const tmux = new FakeTmuxDriver();
  const tasks = new TaskStore(db);
  const app = createServer({
    tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db),
    users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db), planJobs,
  });
  return {
    app, tasks, tmux, planJobs,
    adminTok: users.issueToken(admin.id),
    agentTok: users.refreshAgentToken(admin.id), // agent-scoped token owned by the (admin) service user
  };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const patch = (t: string, body: unknown) => ({ method: 'PATCH', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const post = (t: string, body: unknown) => ({ method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('S51 — spawned agent service token is capability-scoped, not admin', () => {
  it('allows exactly the worker/overseer/pilot verbs the agent CLI drives', async () => {
    const { app, tasks, agentTok } = setup();
    // A live worker in project 1: in_progress + agent label → project 1 is in the agent working set.
    tasks.create({ id: 'orca-t1', project_id: 1, title: 'close me' });
    tasks.setAgent('orca-t1', 'Worker');
    tasks.setStatus('orca-t1', 'in_progress');
    // close its task (orca close → PATCH /tasks/:id)
    expect((await app.request('/tasks/orca-t1', patch(agentTok, { status: 'closed', outcome: 'ok' }))).status).toBe(200);
    // read-only listings (orca ls / ready / sessions)
    expect((await app.request('/tasks', auth(agentTok))).status).toBe(200);
    expect((await app.request('/tasks/ready', auth(agentTok))).status).toBe(200);
    expect((await app.request('/sessions', auth(agentTok))).status).toBe(200);
  });

  it('forbids the admin surface even though the token belongs to the admin user', async () => {
    const { app, agentTok } = setup();
    // user management, config write, project register/delete — all blocked for the agent scope
    expect((await app.request('/users', auth(agentTok))).status).toBe(403);
    expect((await app.request('/config', { method: 'PUT', headers: { authorization: `Bearer ${agentTok}`, 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    expect((await app.request('/projects', post(agentTok, { slug: 'x', path: '/x' }))).status).toBe(403);
    expect((await app.request('/projects/2', { method: 'DELETE', ...auth(agentTok) })).status).toBe(403);
    // arbitrary project data the agent isn't working in
    expect((await app.request('/projects/2/files', auth(agentTok))).status).toBe(403);
  });

  it('lets plan submit + overseer poll/decide through for the agent scope', async () => {
    const { app, planJobs, agentTok } = setup();
    const job = planJobs.create({ goal: 'g', projectId: 1, epicId: null, dryRun: true });
    // plan submit (orca plan submit) — dryRun job, so it records phases without persisting
    expect((await app.request(`/plan/${job.id}/submit`, post(agentTok, { phases: [{ title: 'p1', type: 'task' }] }))).status).toBe(200);
    // overseer decide on an unknown id is a 404 from the queue, NOT a 403 — i.e. the route is reachable
    expect((await app.request('/missions/m-x/overseer/decide', post(agentTok, { id: 'nope', approve: true }))).status).not.toBe(403);
  });

  it('cannot touch a task in a project it is not actively working in (no admin cross-project bypass)', async () => {
    const { app, tasks, agentTok } = setup();
    // A worker is live in project 1, but a task sits idle in project 2 — outside the working set.
    tasks.create({ id: 'orca-here', project_id: 1, title: 'mine' });
    tasks.setAgent('orca-here', 'W'); tasks.setStatus('orca-here', 'in_progress');
    tasks.create({ id: 'p2-foreign', project_id: 2, title: 'not mine' });
    expect((await app.request('/tasks/p2-foreign', patch(agentTok, { status: 'closed' }))).status).toBe(403);
    // And /tasks lists only the working-set project's rows, not the foreign one.
    const visible = await (await app.request('/tasks', auth(agentTok))).json() as Array<{ id: string }>;
    expect(visible.some((t) => t.id === 'orca-here')).toBe(true);
    expect(visible.some((t) => t.id === 'p2-foreign')).toBe(false);
  });

  it('the same admin user with a FULL token still reaches the admin surface', async () => {
    const { app, adminTok } = setup();
    expect((await app.request('/users', auth(adminTok))).status).toBe(200);
  });
});

describe('S10 / #5 — session ownership is enforced on every /sessions/:name route', () => {
  function withAssignment() {
    const s = setup();
    // bob is a non-admin assigned to project 1 only; an agent task runs in project 2.
    const db = (s.tasks as unknown as { db: import('better-sqlite3').Database }).db;
    const users = new UserStore(db);
    const bob = users.create('bob', 'pw');
    db.prepare('INSERT INTO user_projects (user_id, project_id) VALUES (?, 1)').run(bob.id);
    s.tasks.create({ id: 'p2-task', project_id: 2, title: 'foreign' });
    s.tasks.setAgent('p2-task', 'Foreigner'); // → session orca-Foreigner, project 2
    s.tmux.setPane('orca-Foreigner', 'secret pane');
    return { ...s, bobTok: users.issueToken(bob.id) };
  }

  it('a non-admin cannot kill / key / resize / read a session whose task lives in a project they cannot access', async () => {
    const { app, bobTok } = withAssignment();
    expect((await app.request('/sessions/orca-Foreigner', { method: 'DELETE', ...auth(bobTok) })).status).toBe(403);
    expect((await app.request('/sessions/orca-Foreigner/keys', post(bobTok, { keys: ['Enter'] }))).status).toBe(403);
    expect((await app.request('/sessions/orca-Foreigner/resize', post(bobTok, { cols: 80, rows: 24 }))).status).toBe(403);
    expect((await app.request('/sessions/orca-Foreigner/pane', auth(bobTok))).status).toBe(403);
    expect((await app.request('/sessions/orca-Foreigner/stream', auth(bobTok))).status).toBe(403);
  });

  it('admin passes through to every session-control route', async () => {
    const { app, adminTok } = withAssignment();
    expect((await app.request('/sessions/orca-Foreigner', { method: 'DELETE', ...auth(adminTok) })).status).toBe(200);
  });
});
