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
import { openDb } from '../../src/store/db.js';
import { openAgentsDb } from '../helpers/agentsDb.js';

/** With the agents plugin disabled (control absent), the server is built WITHOUT engine/spawn — the
 *  mission/session/plan write paths must answer an explicit 503, never crash on an undefined dep, and
 *  the read paths must keep working off the RouteContext's local fallbacks. */
function setup() {
  const db = openAgentsDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw');
  const config = new ConfigStore(db);
  const tasks = new TaskStore(db);
  const missions = new MissionStore(db);
  const app = createServer({
    tasks, readiness: new Readiness(db), missions, bus: new EventBus(),
    tmux: new FakeTmuxDriver() as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
  });
  return { app, db, tasks, missions, tok: users.issueToken(admin.id) };
}
const post = (t: string, body: unknown) => ({ method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });

describe('agents plugin disabled → explicit degradation (404 mounts, 503 core writes)', () => {
  it('mission engage answers 404 — the /missions mounts do not exist without the plugin', async () => {
    const { app, tasks, tok } = setup();
    tasks.create({ id: 'e1', project_id: 1, title: 'E', type: 'epic' });
    const res = await app.request('/missions', post(tok, { epicId: 'e1' }));
    expect(res.status).toBe(404);
  });

  it('pause/resume/disengage on an existing mission answer 404 (the row is untouched)', async () => {
    const { app, tasks, missions, tok } = setup();
    tasks.create({ id: 'e1', project_id: 1, title: 'E', type: 'epic' });
    missions.create({ id: 'm-e1', epic_id: 'e1', autonomy: 'L3', max_sessions: 1 });
    const patched = await app.request('/missions/m-e1', { ...post(tok, { action: 'pause' }), method: 'PATCH' });
    expect(patched.status).toBe(404); // the plugin's root mounts are absent entirely
    const deleted = await app.request('/missions/m-e1', { method: 'DELETE', ...auth(tok) });
    expect(deleted.status).toBe(404);
    expect(missions.get('m-e1')?.state).toBe('active'); // untouched
  });

  it('manual session launch answers 404 and leaves the task open', async () => {
    const { app, tasks, tok } = setup();
    tasks.create({ id: 't1', project_id: 1, title: 'T' });
    const res = await app.request('/sessions', post(tok, { taskId: 't1' }));
    expect(res.status).toBe(404); // the plugin's /sessions mount is absent entirely
    expect(tasks.get('t1')!.status).toBe('open'); // not claimed then stranded
  });

  it('plan with engage=true answers 503; a pure plan (no engage) still works', async () => {
    const { app, tok } = setup();
    const engaged = await app.request('/tasks/plan', post(tok, { goal: 'g', engage: true, phases: [{ title: 'p1' }] }));
    expect(engaged.status).toBe(503);
    const planned = await app.request('/tasks/plan', post(tok, { goal: 'g', phases: [{ title: 'p1' }] }));
    expect(planned.status).toBe(201); // epic + phases persist without the engine
  });

  it('deleting an epic with a LIVE mission refuses with 503 (teardown-first); reads keep working', async () => {
    const { app, tasks, missions, tok } = setup();
    tasks.create({ id: 'e1', project_id: 1, title: 'E', type: 'epic' });
    missions.create({ id: 'm-e1', epic_id: 'e1', autonomy: 'L3', max_sessions: 1 });
    const res = await app.request('/tasks/e1', { method: 'DELETE', ...auth(tok) });
    expect(res.status).toBe(503);
    expect(tasks.get('e1')).not.toBeNull(); // nothing was deleted under a mission nobody can stop
    // The overseer long-poll lives on the plugin's mount now → 404 without it; the core plan-job
    // read path keeps its own 404 semantics.
    expect((await app.request('/missions/m-e1/overseer/next?timeoutMs=20', auth(tok))).status).toBe(404);
    expect((await app.request('/plan/pj-nope', auth(tok))).status).toBe(404);
  });

  it('admin cleanup refuses with 503 while a mission is live (teardown-first, nothing wiped)', async () => {
    const { app, tasks, missions, tok } = setup();
    tasks.create({ id: 'e1', project_id: 1, title: 'E', type: 'epic' });
    missions.create({ id: 'm-e1', epic_id: 'e1', autonomy: 'L3', max_sessions: 1 });
    const res = await app.request('/admin/cleanup', post(tok, {}));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'agents plugin is disabled' });
    expect(tasks.get('e1')).not.toBeNull(); // rows survive — no wipe under live agents nobody can stop
    expect(missions.get('m-e1')?.state).toBe('active');
  });

  it('FRESH install (agents tables never created): epic delete and admin cleanup succeed', async () => {
    // A fresh daemon with the plugin disabled has NO missions/mission_pr/agents/notes tables at all —
    // the destructive core paths must tolerate that shape, not crash on "no such table".
    const db = openDb(':memory:');
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    const users = new UserStore(db);
    const admin = users.create('admin', 'pw');
    const tasks = new TaskStore(db);
    const app = createServer({
      tasks, readiness: new Readiness(db), missions: { get: () => null, active: () => [], live: () => [], activeForEpic: () => null }, bus: new EventBus(),
      tmux: new FakeTmuxDriver() as never,
      project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
      clock: new FakeClock(0), config: new ConfigStore(db), users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
    });
    const tok = users.issueToken(admin.id);
    tasks.create({ id: 'e1', project_id: 1, title: 'E', type: 'epic' });
    tasks.create({ id: 'p1', project_id: 1, title: 'P', parent_id: 'e1' });
    const del = await app.request('/tasks/e1', { method: 'DELETE', ...auth(tok) });
    expect(del.status).toBe(200);
    expect(tasks.get('e1')).toBeNull();
    tasks.create({ id: 't2', project_id: 1, title: 'T2' });
    const wipe = await app.request('/admin/cleanup', post(tok, {}));
    expect(wipe.status).toBe(200);
    expect(tasks.list()).toEqual([]);
  });

  it('an AGENT token is 403 on the overseer verbs without the plugin (no static allow-list hole)', async () => {
    // The middleware's agent allow-list no longer names the overseer routes — they pass only through
    // the rootApiRoute(access:'agent') carve-out, which needs the plugin loaded. Disabled plugin ⇒ a
    // prompt-injected agent token must be REFUSED (403), not fall through to some core 404 surface.
    // The enabled twin lives in serviceToken.test.ts ("plan submit + overseer poll/decide").
    const { app, db } = setup();
    const agentTok = new UserStore(db).ensureAgentToken(1);
    expect((await app.request('/missions/m-x/overseer/next?timeoutMs=20', auth(agentTok))).status).toBe(403);
    expect((await app.request('/missions/m-x/overseer/decide', post(agentTok, { id: 'n', approve: true }))).status).toBe(403);
  });
});
