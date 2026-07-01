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
import type { CommitFileChange } from '../../src/integrations/projectFiles.js';

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'home','/o')").run();
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'other','/p2')").run();
  const users = new UserStore(db);
  users.create('admin', 'pw'); // claims the bootstrap-admin slot so bob is a plain member (gate stays meaningful)
  const bob = users.create('bob', 'pw');
  const userProjects = new UserProjectStore(db);
  userProjects.assign(bob.id, 1);
  const tasks = new TaskStore(db);
  const missions = new MissionStore(db);
  const app = createServer({
    tasks, readiness: new Readiness(db), missions, bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db),
    users, projects: new ProjectStore(db), userProjects,
  });
  return { app, tasks, missions, bobTok: users.issueToken(bob.id) };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });

/** Seed an epic (in the given project) with its child phases, stamping each phase's frozen change list. */
function seedMission(tasks: TaskStore, missions: MissionStore, epicId: string, projectId: number, phases: CommitFileChange[][]) {
  const epic = tasks.create({ id: epicId, project_id: projectId, title: 'Epic', type: 'epic', description: 'e' });
  phases.forEach((files, i) => {
    const phase = tasks.create({ id: `${epicId}-p${i}`, project_id: projectId, title: `Phase ${i}`, type: 'task', parent_id: epic.id, description: 'p' });
    if (files.length > 0) tasks.saveChangedFiles(phase.id, files, 'aaaa', 'bbbb');
  });
  return missions.create({ id: `m-${epic.id}`, epic_id: epic.id, autonomy: 'L3', max_sessions: 1 });
}

describe('GET /missions/:id/changed-files', () => {
  it('aggregates and dedupes changed_files across phases, sorted by churn desc', async () => {
    const { app, tasks, missions, bobTok } = setup();
    seedMission(tasks, missions, 'orca-E', 1, [
      [{ path: 'a.ts', added: 5, deleted: 2 }, { path: 'shared.ts', added: 1, deleted: 1 }],
      [{ path: 'shared.ts', added: 10, deleted: 3 }, { path: 'b.ts', added: 2, deleted: 0 }],
    ]);
    const res = await app.request('/missions/m-orca-E/changed-files', auth(bobTok));
    expect(res.status).toBe(200);
    const body = await res.json() as CommitFileChange[];
    // shared.ts summed across both phases (11/4 → 15 churn) leads; then a.ts (7); then b.ts (2).
    expect(body).toEqual([
      { path: 'shared.ts', added: 11, deleted: 4 },
      { path: 'a.ts', added: 5, deleted: 2 },
      { path: 'b.ts', added: 2, deleted: 0 },
    ]);
  });

  it('returns [] when the mission phases have no changes', async () => {
    const { app, tasks, missions, bobTok } = setup();
    seedMission(tasks, missions, 'orca-empty', 1, [[], []]);
    const res = await app.request('/missions/m-orca-empty/changed-files', auth(bobTok));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('404s an unknown mission', async () => {
    const { app, bobTok } = setup();
    expect((await app.request('/missions/m-nope/changed-files', auth(bobTok))).status).toBe(404);
  });

  it('403s when the caller cannot access the mission project', async () => {
    const { app, tasks, missions, bobTok } = setup();
    // Epic lives in project 2; bob is only assigned project 1.
    seedMission(tasks, missions, 'orca-foreign', 2, [[{ path: 'x.ts', added: 1, deleted: 0 }]]);
    expect((await app.request('/missions/m-orca-foreign/changed-files', auth(bobTok))).status).toBe(403);
  });
});
