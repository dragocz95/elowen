import { describe, it, expect } from 'vitest';
import { TaskRefs } from '../../src/store/taskRefs.js';
import { TaskStore } from '../../plugins/work/src/store/taskStore.js';
import { Readiness } from '../../plugins/work/src/store/readiness.js';
import { MissionStore } from '../../plugins/agents/src/store/missionStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { agentsPluginProvider } from '../helpers/testApp.js';
import { FakeClock } from '../../src/shared/clock.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import type { PlanJobStore } from '../../plugins/agents/src/overseer/planJob.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';

async function setup() {
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'other','/other')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw'); // first user → is_admin
  const tmux = new FakeTmuxDriver();
  const tasks = new TaskStore(db);
  const readiness = new Readiness(db);
  const config = new ConfigStore(db);
  const projects = new ProjectStore(db);
  // '/sessions', the whole /tasks family and /plan/* are plugin-served now (same fake tmux).
  const provider = agentsPluginProvider({ db, tasks, readiness, config, projects, users, tmux });
  const registry = await provider.get();
  const control = registry.control('missions');
  if (!control) throw new Error('agents plugin failed to load in setup');
  // The plan jobs the routes resolve live through the agents control — the same store the plan submit
  // route reads, so a job arranged here is the one it finds.
  const planJobs = control.planJobs() as PlanJobStore;
  const app = createServer({
    tasks, taskRefs: new TaskRefs(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as never, tmux,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config,
    users, projects, userProjects: new UserProjectStore(db),
    plugins: provider,
  });
  return {
    app, tasks, tmux, planJobs, users, admin,
    adminTok: users.issueToken(admin.id),
    agentTok: users.ensureAgentToken(admin.id), // agent-scoped token owned by the (admin) service user
  };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const patch = (t: string, body: unknown) => ({ method: 'PATCH', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const post = (t: string, body: unknown) => ({ method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('S51 — spawned agent service token is capability-scoped, not admin', () => {
  it('allows exactly the worker/overseer/pilot verbs the agent CLI drives', async () => {
    const { app, tasks, agentTok } = await setup();
    // A live worker in project 1: in_progress + agent label → project 1 is in the agent working set.
    tasks.create({ id: 'elowen-t1', project_id: 1, title: 'close me' });
    tasks.setAgent('elowen-t1', 'Worker');
    tasks.setStatus('elowen-t1', 'in_progress');
    // close its task (elowen close → PATCH /tasks/:id)
    expect((await app.request('/tasks/elowen-t1', patch(agentTok, { status: 'closed', outcome: 'ok' }))).status).toBe(200);
    // but the PATCH is field-scoped to close: an agent can't rewrite exec/title/etc. on a task in its
    // project (intra-tenant integrity) — those fields are 403 even though the route is reachable.
    expect((await app.request('/tasks/elowen-t1', patch(agentTok, { exec: 'codex:gpt-5.5' }))).status).toBe(403);
    expect((await app.request('/tasks/elowen-t1', patch(agentTok, { title: 'renamed' }))).status).toBe(403);
    // read-only listings (elowen ls / ready / sessions)
    expect((await app.request('/tasks', auth(agentTok))).status).toBe(200);
    expect((await app.request('/tasks/ready', auth(agentTok))).status).toBe(200);
    expect((await app.request('/sessions', auth(agentTok))).status).toBe(200);
  });

  it('forbids the admin surface even though the token belongs to the admin user', async () => {
    const { app, agentTok } = await setup();
    // user management, config write, project register/delete — all blocked for the agent scope
    expect((await app.request('/users', auth(agentTok))).status).toBe(403);
    expect((await app.request('/config', { method: 'PUT', headers: { authorization: `Bearer ${agentTok}`, 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    expect((await app.request('/projects', post(agentTok, { slug: 'x', path: '/x' }))).status).toBe(403);
    expect((await app.request('/projects/2', { method: 'DELETE', ...auth(agentTok) })).status).toBe(403);
    // arbitrary project data the agent isn't working in
    expect((await app.request('/projects/2/files', auth(agentTok))).status).toBe(403);
    // the System surface (incl. agent-skill install) is admin-only and never in the agent allow-list
    expect((await app.request('/system/skills', auth(agentTok))).status).toBe(403);
    expect((await app.request('/system/skills/install', post(agentTok, {}))).status).toBe(403);
  });

  it('lets plan submit + overseer poll/decide through for the agent scope', async () => {
    const { app, planJobs, agentTok } = await setup();
    const job = planJobs.create({ goal: 'g', projectId: 1, epicId: null, dryRun: true });
    // plan submit (elowen plan submit) — dryRun job, so it records phases without persisting
    expect((await app.request(`/plan/${job.id}/submit`, post(agentTok, { phases: [{ title: 'p1', type: 'task' }] }))).status).toBe(200);
    // overseer decide on an unknown id is a 404 from the queue, NOT a 403 — i.e. the route is reachable
    expect((await app.request('/missions/m-x/overseer/decide', post(agentTok, { id: 'nope', approve: true }))).status).not.toBe(403);
  });

  it('lets the worker drive `elowen ask` (start + poll) but never the human reply', async () => {
    const { app, tasks, agentTok } = await setup();
    tasks.create({ id: 'elowen-ask', project_id: 1, title: 'ask me' });
    tasks.setAgent('elowen-ask', 'Worker'); tasks.setStatus('elowen-ask', 'in_progress');
    // post an open question to the autopilot (elowen ask) — reachable, not 403
    expect((await app.request('/tasks/elowen-ask/ask', post(agentTok, { text: 'A or B?' }))).status).toBe(200);
    // long-poll its reply — reachable (404 'no such ask' for a bogus id, NOT 403)
    expect((await app.request('/tasks/elowen-ask/ask/bogus?timeoutMs=1', auth(agentTok))).status).not.toBe(403);
    // the human reply is off-limits to the agent: it must not answer its own question
    expect((await app.request('/tasks/elowen-ask/ask/bogus/reply', post(agentTok, { text: 'self-answer' }))).status).toBe(403);
    // the pending-ask inbox is a human surface — an agent token can't enumerate it
    expect((await app.request('/asks/pending', auth(agentTok))).status).toBe(403);
  });

  it('lets the worker fetch its control guide (`elowen help`) but not a foreign task\'s', async () => {
    const { app, tasks, agentTok } = await setup();
    tasks.create({ id: 'elowen-guide', project_id: 1, title: 'guide me' });
    tasks.setAgent('elowen-guide', 'Worker'); tasks.setStatus('elowen-guide', 'in_progress');
    // its own guide is reachable (200), not 403
    expect((await app.request('/tasks/elowen-guide/guide', auth(agentTok))).status).toBe(200);
    // a task in a project it isn't working in stays forbidden
    tasks.create({ id: 'p2-guide', project_id: 2, title: 'not mine' });
    expect((await app.request('/tasks/p2-guide/guide', auth(agentTok))).status).toBe(403);
  });

  it('cannot touch a task in a project it is not actively working in (no admin cross-project bypass)', async () => {
    const { app, tasks, agentTok } = await setup();
    // A worker is live in project 1, but a task sits idle in project 2 — outside the working set.
    tasks.create({ id: 'elowen-here', project_id: 1, title: 'mine' });
    tasks.setAgent('elowen-here', 'W'); tasks.setStatus('elowen-here', 'in_progress');
    tasks.create({ id: 'p2-foreign', project_id: 2, title: 'not mine' });
    expect((await app.request('/tasks/p2-foreign', patch(agentTok, { status: 'closed' }))).status).toBe(403);
    // And /tasks lists only the working-set project's rows, not the foreign one.
    const visible = await (await app.request('/tasks', auth(agentTok))).json() as Array<{ id: string }>;
    expect(visible.some((t) => t.id === 'elowen-here')).toBe(true);
    expect(visible.some((t) => t.id === 'p2-foreign')).toBe(false);
  });

  it('the same admin user with a FULL token still reaches the admin surface', async () => {
    const { app, adminTok } = await setup();
    expect((await app.request('/users', auth(adminTok))).status).toBe(200);
  });
});

describe('an agent token is bound to the task it was spawned for', () => {
  /** Two live workers in the SAME project — the crossing the project gate structurally cannot see. */
  async function twoWorkers() {
    const s = await setup();
    for (const [id, agent] of [['task-a', 'Alpha'], ['task-b', 'Beta']] as const) {
      s.tasks.create({ id, project_id: 1, title: id });
      s.tasks.setAgent(id, agent);
      s.tasks.setStatus(id, 'in_progress');
    }
    return { ...s, aTok: s.users.ensureAgentTokenForTask(s.admin.id, 'task-a') };
  }

  it('refuses every task verb aimed at a sibling task in the same project', async () => {
    const { app, tasks, aTok } = await twoWorkers();
    expect((await app.request('/tasks/task-b', patch(aTok, { status: 'closed', outcome: 'ok' }))).status).toBe(403);
    expect((await app.request('/tasks/task-b/ask', post(aTok, { text: 'hijack' }))).status).toBe(403);
    expect((await app.request('/tasks/task-b/guide', auth(aTok))).status).toBe(403);
    expect(tasks.get('task-b')?.status).toBe('in_progress'); // the sibling really is untouched
  });

  it('still allows everything the worker legitimately does on its OWN task', async () => {
    const { app, tasks, aTok } = await twoWorkers();
    expect((await app.request('/tasks/task-a/guide', auth(aTok))).status).toBe(200);
    expect((await app.request('/tasks/task-a/ask', post(aTok, { text: 'A or B?' }))).status).toBe(200);
    expect((await app.request('/tasks/task-a/ask/bogus?timeoutMs=1', auth(aTok))).status).not.toBe(403);
    // read-only listings carry no task id and stay reachable (`elowen ls` / `ready` / `sessions`)
    expect((await app.request('/tasks', auth(aTok))).status).toBe(200);
    expect((await app.request('/tasks/ready', auth(aTok))).status).toBe(200);
    expect((await app.request('/sessions', auth(aTok))).status).toBe(200);
    expect((await app.request('/tasks/task-a', patch(aTok, { status: 'closed', outcome: 'ok' }))).status).toBe(200);
    expect(tasks.get('task-a')?.status).toBe('closed');
  });

  it('answers a malformed task segment with a refusal, not a crash', async () => {
    // The guard percent-decodes the segment to compare it with the bound task, and `%` alone makes
    // decodeURIComponent throw. An agent can send that path, so a throw here would turn an
    // authorisation decision into a 500 from the middleware.
    const { app, aTok } = await twoWorkers();
    expect((await app.request('/tasks/%/guide', auth(aTok))).status).toBe(403);
    expect((await app.request('/tasks/%zz', patch(aTok, { status: 'closed', outcome: 'ok' }))).status).toBe(403);
  });

  it('lets a mission phase close its own parent epic, but not another epic', async () => {
    const s = await setup();
    s.tasks.create({ id: 'epic-1', project_id: 1, title: 'mine', type: 'epic' });
    s.tasks.create({ id: 'epic-2', project_id: 1, title: 'someone else', type: 'epic' });
    s.tasks.create({ id: 'phase-1', project_id: 1, title: 'final phase', parent_id: 'epic-1' });
    s.tasks.setAgent('phase-1', 'Alpha');
    s.tasks.setStatus('phase-1', 'in_progress');
    const tok = s.users.ensureAgentTokenForTask(s.admin.id, 'phase-1');
    expect((await s.app.request('/tasks/epic-2', patch(tok, { status: 'closed', outcome: 'ok' }))).status).toBe(403);
    expect((await s.app.request('/tasks/epic-1', patch(tok, { status: 'closed', outcome: 'ok' }))).status).toBe(200);
  });

  it('leaves the unbound service token (overseer/pilot) reaching what it did before', async () => {
    const { app, agentTok } = await twoWorkers();
    expect((await app.request('/tasks/task-b', patch(agentTok, { status: 'closed', outcome: 'ok' }))).status).toBe(200);
  });
});

describe('S10 / #5 — session ownership is enforced on every /sessions/:name route', () => {
  async function withAssignment() {
    const s = await setup();
    // bob is a non-admin assigned to project 1 only; an agent task runs in project 2.
    const db = (s.tasks as unknown as { db: import('better-sqlite3').Database }).db;
    const users = new UserStore(db);
    const bob = users.create('bob', 'pw');
    db.prepare('INSERT INTO user_projects (user_id, project_id) VALUES (?, 1)').run(bob.id);
    s.tasks.create({ id: 'p2-task', project_id: 2, title: 'foreign' });
    s.tasks.setAgent('p2-task', 'Foreigner'); // → session elowen-Foreigner, project 2
    s.tmux.setPane('elowen-Foreigner', 'secret pane');
    return { ...s, bobTok: users.issueToken(bob.id) };
  }

  it('a non-admin cannot kill / key / resize / read a session whose task lives in a project they cannot access', async () => {
    const { app, bobTok } = await withAssignment();
    expect((await app.request('/sessions/elowen-Foreigner', { method: 'DELETE', ...auth(bobTok) })).status).toBe(403);
    expect((await app.request('/sessions/elowen-Foreigner/keys', post(bobTok, { keys: ['Enter'] }))).status).toBe(403);
    expect((await app.request('/sessions/elowen-Foreigner/resize', post(bobTok, { cols: 80, rows: 24 }))).status).toBe(403);
    expect((await app.request('/sessions/elowen-Foreigner/pane', auth(bobTok))).status).toBe(403);
    expect((await app.request('/sessions/elowen-Foreigner/stream', auth(bobTok))).status).toBe(403);
  });

  it('admin passes through to every session-control route', async () => {
    const { app, adminTok } = await withAssignment();
    expect((await app.request('/sessions/elowen-Foreigner', { method: 'DELETE', ...auth(adminTok) })).status).toBe(200);
  });
});
