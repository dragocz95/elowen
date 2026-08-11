import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { MissionStore } from '../../src/store/missionStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';

/** With the agents plugin disabled (control absent), the server is built WITHOUT engine/spawn — the
 *  mission/session/plan write paths must answer an explicit 503, never crash on an undefined dep, and
 *  the read paths must keep working off the RouteContext's local fallbacks. */
function setup() {
  const db = openDb(':memory:');
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

describe('agents plugin disabled → explicit 503 degradation', () => {
  it('mission engage answers 503, not a crash', async () => {
    const { app, tasks, tok } = setup();
    tasks.create({ id: 'e1', project_id: 1, title: 'E', type: 'epic' });
    const res = await app.request('/missions', post(tok, { epicId: 'e1' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'agents plugin is disabled' });
  });

  it('pause/resume/disengage on an existing mission answer 503 (the row is untouched)', async () => {
    const { app, tasks, missions, tok } = setup();
    tasks.create({ id: 'e1', project_id: 1, title: 'E', type: 'epic' });
    missions.create({ id: 'm-e1', epic_id: 'e1', autonomy: 'L3', max_sessions: 1 });
    const patched = await app.request('/missions/m-e1', { ...post(tok, { action: 'pause' }), method: 'PATCH' });
    expect(patched.status).toBe(503);
    const deleted = await app.request('/missions/m-e1', { method: 'DELETE', ...auth(tok) });
    expect(deleted.status).toBe(503);
    expect(missions.get('m-e1')?.state).toBe('active'); // refused BEFORE any state change
  });

  it('manual session launch answers 503 and leaves the task open', async () => {
    const { app, tasks, tok } = setup();
    tasks.create({ id: 't1', project_id: 1, title: 'T' });
    const res = await app.request('/sessions', post(tok, { taskId: 't1' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'agents plugin is disabled' });
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
    // Read paths stay up on the RouteContext fallbacks: overseer long-poll → empty, unknown plan → 404.
    const next = await app.request('/missions/m-e1/overseer/next?timeoutMs=20', auth(tok));
    expect(next.status).toBe(200);
    expect((await app.request('/plan/pj-nope', auth(tok))).status).toBe(404);
  });
});
