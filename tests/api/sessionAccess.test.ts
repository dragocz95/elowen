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

// Two projects; bob is assigned to #1 only. A worker session belongs to its task's project, so the
// /sessions list (visibility) must mirror the per-session control gate (operability), not leak globally.
function setup() {
  const db = openAgentsDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'home','/o')").run();
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'other','/p2')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw'); // id 1, is_admin
  const bob = users.create('bob', 'pw');      // id 2
  const userProjects = new UserProjectStore(db);
  userProjects.assign(bob.id, 1);
  const tasks = new TaskStore(db);
  tasks.create({ id: 't1', project_id: 1, title: 'home task' });
  tasks.create({ id: 't2', project_id: 2, title: 'foreign task' });
  tasks.setAgent('t1', 'Nova'); // session elowen-Nova → t1 (project 1)
  tasks.setAgent('t2', 'Zar');  // session elowen-Zar  → t2 (project 2)
  const tmux = new FakeTmuxDriver();
  for (const s of ['elowen-Nova', 'elowen-Zar', `elowen-advisor-${bob.id}`, `elowen-advisor-${admin.id}`]) tmux.setPane(s, '');
  const readiness = new Readiness(db);
  const config = new ConfigStore(db);
  const projects = new ProjectStore(db);
  const app = createServer({
    tasks, taskRefs: new TaskRefs(db), readiness, missions: new MissionStore(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: tmux as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config,
    users, projects, userProjects,
    // '/sessions' is plugin-served now (same fake tmux, so the list sees the seeded panes).
    plugins: agentsPluginProvider({ db, tasks, readiness, config, projects, users, tmux }),
  });
  return { app, adminTok: users.issueToken(admin.id), bobTok: users.issueToken(bob.id), bobId: bob.id, adminId: admin.id };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const names = async (app: ReturnType<typeof setup>['app'], tok: string) =>
  ((await (await app.request('/sessions', auth(tok))).json()) as { name: string }[]).map((s) => s.name).sort();

describe('GET /sessions tenancy filtering', () => {
  it('shows a non-admin only sessions in their projects plus their own advisor', async () => {
    const { app, bobTok, bobId } = setup();
    expect(await names(app, bobTok)).toEqual(['elowen-Nova', `elowen-advisor-${bobId}`].sort());
  });

  it('shows an admin every running session', async () => {
    const { app, adminTok, bobId, adminId } = setup();
    expect(await names(app, adminTok)).toEqual(['elowen-Nova', 'elowen-Zar', `elowen-advisor-${bobId}`, `elowen-advisor-${adminId}`].sort());
  });
});
