import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { MissionStore } from '../../src/store/missionStore.js';
import { AgentStore } from '../../src/store/agentStore.js';
import { SpawnService } from '../../src/spawn/spawn.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { TaskUsageStore } from '../../src/store/taskUsageStore.js';

const usage = { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, total: 165, costUsd: 0.5 };

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw'); // first user → is_admin
  const bob = users.create('bob', 'pw');
  const tmux = new FakeTmuxDriver();
  const taskUsage = new TaskUsageStore(db);
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: { disengage: async () => {} } as never, spawn: new SpawnService({ tmux, agents: new AgentStore(db) }), tmux,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db),
    users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db), taskUsage,
  });
  return { app, db, taskUsage, adminTok: users.issueToken(admin.id), bobTok: users.issueToken(bob.id) };
}
const auth = (t: string | null) => ({ headers: t ? { authorization: `Bearer ${t}` } : {} });
const post = (t: string | null) => ({ method: 'POST', headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), 'content-type': 'application/json' }, body: '{}' });

describe('GET /usage/by-model', () => {
  it('returns the persisted aggregate per exec from the DB', async () => {
    const { app, taskUsage, adminTok } = setup();
    taskUsage.record('t1', 1, 'sonnet', usage);
    taskUsage.record('t2', 1, 'sonnet', usage);
    const res = await app.request('/usage/by-model', auth(adminTok));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].exec).toBe('sonnet');
    expect(body[0].usage.total).toBe(330);
    expect(body[0].usage.costUsd).toBe(1);
  });

  it('narrows to a ?from=&to= window', async () => {
    const { app, db, taskUsage, adminTok } = setup();
    taskUsage.record('old', 1, 'sonnet', usage);
    db.prepare("UPDATE task_usage SET captured_at = '2020-01-01 00:00:00' WHERE task_id = 'old'").run();
    taskUsage.record('recent', 1, 'sonnet', usage);
    const res = await app.request('/usage/by-model?from=2026-06-01T00:00:00.000Z', auth(adminTok));
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].usage.total).toBe(165); // only 'recent', 'old' excluded by the window
  });

  it('ignores a malformed ?from= (no 400, unfiltered result)', async () => {
    const { app, taskUsage, adminTok } = setup();
    taskUsage.record('t1', 1, 'sonnet', usage);
    const res = await app.request('/usage/by-model?from=notadate', auth(adminTok));
    expect(res.status).toBe(200);
    expect((await res.json())[0].usage.total).toBe(165);
  });
});

describe('POST /usage/reset', () => {
  it('forbids a non-admin (403)', async () => {
    const { app, bobTok } = setup();
    expect((await app.request('/usage/reset', post(bobTok))).status).toBe(403);
  });

  it('wipes the snapshots and returns the count (admin)', async () => {
    const { app, taskUsage, adminTok } = setup();
    taskUsage.record('t1', 1, 'sonnet', usage);
    taskUsage.record('t2', 1, 'opus', usage);
    const res = await app.request('/usage/reset', post(adminTok));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cleared: 2 });
    expect(taskUsage.aggregateByExec()).toEqual([]);
  });
});
