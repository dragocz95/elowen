import { describe, it, expect } from 'vitest';
import { TaskRefs } from '../../src/store/taskRefs.js';
import { TaskStore } from '../../plugins/work/src/store/taskStore.js';
import { Readiness } from '../../plugins/work/src/store/readiness.js';
import { MissionStore } from '../../plugins/agents/src/store/missionStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { agentsPluginProvider } from '../helpers/testApp.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { openAgentsDb } from '../helpers/agentsDb.js';

async function setup() {
  const db = openAgentsDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  users.create('admin', 'pw'); // first user becomes admin — keep amy a non-admin member
  const amy = users.create('amy', 'pw');
  const config = new ConfigStore(db);
  config.update({ allowedExecs: ['sonnet'] });
  const tmux = new FakeTmuxDriver();
  const tasks = new TaskStore(db);
  const readiness = new Readiness(db);
  const projects = new ProjectStore(db);
  // The '/advisor' surface is a plugin ROOT MOUNT now: the REAL agents plugin serves it, with the
  // advisor collaborators seam built over this test's UserStore (agentsTestHost default).
  const provider = agentsPluginProvider({ db, tasks, readiness, config, projects, users, tmux });
  const registry = await provider.get();
  const app = createServer({
    tasks, taskRefs: new TaskRefs(db), readiness, missions: new MissionStore(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: tmux as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, users, projects, userProjects: new UserProjectStore(db),
    plugins: provider,
    // Mirror bootstrap: login autostart resolves the plugin's advisor through the control.
    advisor: registry.control('agents')!.advisor(),
  });
  return { app, users, amy, amyTok: users.issueToken(amy.id), agentTok: users.issueToken(amy.id, 'agent') };
}

const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const post = (t: string, body: unknown) => ({ method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('advisor routes', () => {
  it('status → start → stop happy path', async () => {
    const { app, amyTok } = await setup();
    expect((await (await app.request('/advisor/status', auth(amyTok))).json() as { running: boolean }).running).toBe(false);
    const start = await app.request('/advisor/start', post(amyTok, { exec: 'sonnet' }));
    expect(start.status).toBe(201);
    expect((await (await app.request('/advisor/status', auth(amyTok))).json() as { running: boolean }).running).toBe(true);
    expect((await app.request('/advisor/stop', post(amyTok, {}))).status).toBe(200);
  });

  it('rejects an exec not in the allow-list with 403', async () => {
    const { app, amyTok } = await setup();
    expect((await app.request('/advisor/start', post(amyTok, { exec: 'opus' }))).status).toBe(403);
  });


  it('requires the exec field (400)', async () => {
    const { app, amyTok } = await setup();
    expect((await app.request('/advisor/start', post(amyTok, {}))).status).toBe(400);
  });

  it('an agent-scoped token cannot use advisor routes', async () => {
    const { app, agentTok } = await setup();
    expect((await app.request('/advisor/status', auth(agentTok))).status).toBe(403);
    expect((await app.request('/advisor/start', post(agentTok, { exec: 'sonnet' }))).status).toBe(403);
  });

  it('killing the advisor from the sessions list disables autostart, so login keeps it down', async () => {
    const { app, users, amy, amyTok } = await setup();
    await app.request('/advisor/start', post(amyTok, { exec: 'sonnet' })); // running, autostart armed
    expect(users.get(amy.id)?.advisor_autostart).toBe(true);
    // Kill it via the generic session route (the Sessions page) — not the advisor pane's Stop button.
    const del = await app.request(`/sessions/elowen-advisor-${amy.id}`, { method: 'DELETE', ...auth(amyTok) });
    expect(del.status).toBe(200);
    expect(users.get(amy.id)?.advisor_autostart).toBe(false); // the kill is an explicit "turn it off"
    // A fresh login must NOT resurrect it.
    const res = await app.request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'amy', password: 'pw' }) });
    await new Promise((r) => setTimeout(r, 20));
    const tok = (await res.json() as { token: string }).token;
    expect((await (await app.request('/advisor/status', auth(tok))).json() as { running: boolean }).running).toBe(false);
  });

  it('killing a non-advisor session does not touch advisor autostart', async () => {
    const { app, users, amy, amyTok } = await setup();
    await app.request('/advisor/start', post(amyTok, { exec: 'sonnet' }));
    await app.request('/sessions/elowen-some-agent-7', { method: 'DELETE', ...auth(amyTok) }).catch(() => {});
    expect(users.get(amy.id)?.advisor_autostart).toBe(true); // unaffected
  });

  it('login brings a remembered advisor back up (autostart)', async () => {
    const { app, users, amy } = await setup();
    users.setAdvisorExec(amy.id, 'sonnet'); // pretend amy set it up before
    const res = await app.request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'amy', password: 'pw' }) });
    expect(res.status).toBe(200);
    // ensureOnLogin is fire-and-forget; let the microtask settle, then status should be running.
    await new Promise((r) => setTimeout(r, 20));
    const tok = (await res.json() as { token: string }).token;
    expect((await (await app.request('/advisor/status', auth(tok))).json() as { running: boolean }).running).toBe(true);
  });
});
