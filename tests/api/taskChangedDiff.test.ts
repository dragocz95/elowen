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

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'home','/o')").run();
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'other','/p2')").run();
  const users = new UserStore(db);
  users.create('admin', 'pw'); // claims the bootstrap-admin slot so bob is a plain member (access gate stays meaningful)
  const bob = users.create('bob', 'pw');
  const userProjects = new UserProjectStore(db);
  userProjects.assign(bob.id, 1);
  const tasks = new TaskStore(db);
  tasks.create({ id: 't1', project_id: 1, title: 'home task' });
  tasks.create({ id: 't2', project_id: 2, title: 'foreign task' });
  const app = createServer({
    tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db),
    users, projects: new ProjectStore(db), userProjects,
  });
  return { app, bobTok: users.issueToken(bob.id) };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });

describe('GET /tasks/:id/changed/diff', () => {
  it('returns an empty diff for a task with no snapshot (not yet closed)', async () => {
    const { app, bobTok } = setup();
    const r = await app.request('/tasks/t1/changed/diff?path=a.ts', auth(bobTok));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ diff: '' });
  });

  it('gates by the task project (403) and 404s an unknown task', async () => {
    const { app, bobTok } = setup();
    expect((await app.request('/tasks/t2/changed/diff?path=a.ts', auth(bobTok))).status).toBe(403);
    expect((await app.request('/tasks/nope/changed/diff?path=a.ts', auth(bobTok))).status).toBe(404);
  });
});
