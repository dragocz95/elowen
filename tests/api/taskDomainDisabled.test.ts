import { describe, it, expect } from 'vitest';
import { TaskStore } from '../../plugins/work/src/store/taskStore.js';
import { Readiness } from '../../plugins/work/src/store/readiness.js';
import { TaskRefs } from '../../src/store/taskRefs.js';
import { MissionStore } from '../../plugins/agents/src/store/missionStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { openAgentsDb } from '../helpers/agentsDb.js';

/** A daemon whose task domain either has an owner (the work plugin loaded) or has none (it is disabled).
 *  The domain's stores are the ONLY difference — everything else is wired identically. */
function makeApp(owned: boolean) {
  const db = openAgentsDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const app = createServer({
    ...(owned ? { tasks: new TaskStore(db), readiness: new Readiness(db) } : {}),
    taskRefs: new TaskRefs(db),
    missions: new MissionStore(db), bus: new EventBus(), tmux: new FakeTmuxDriver(),
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db), projects: new ProjectStore(db),
  });
  return { app, db };
}

describe('the task API without an owner for the task domain', () => {
  // The dishonest failure this guards against is an EMPTY 200: with no store behind it, a task list
  // that answers `[]` tells the CLI, the web UI and a spawned agent "this instance has no tasks",
  // which is a different statement from "task tracking is off here".
  it('answers 503 — never an empty list — on every path of the task family', async () => {
    const { app } = makeApp(false);
    const paths: [string, string][] = [
      ['GET', '/tasks'], ['POST', '/tasks'], ['GET', '/tasks/ready'], ['GET', '/tasks/deps'],
      ['GET', '/tasks/t-1'], ['PATCH', '/tasks/t-1'], ['DELETE', '/tasks/t-1'],
      ['GET', '/tasks/t-1/usage'], ['GET', '/tasks/t-1/deps'], ['GET', '/tasks/t-1/conversation'],
      ['GET', '/tasks/t-1/commits'], ['GET', '/tasks/t-1/changed/diff'], ['GET', '/tasks/t-1/commit/abc/diff'],
      ['POST', '/tasks/plan'], ['POST', '/tasks/e-1/phases'], ['GET', '/plan/j-1'], ['POST', '/plan/j-1/submit'],
    ];
    for (const [method, path] of paths) {
      const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }) });
      expect(`${method} ${path} → ${res.status}`).toBe(`${method} ${path} → 503`);
      expect(await res.json()).toEqual({ error: 'task tracking is unavailable (its plugin is disabled)' });
    }
  });

  // The gate must be exactly this family. A neighbouring surface that merely starts with the same word,
  // and the paths another plugin root-mounts under /tasks/:id, are not ours to answer for.
  it('leaves the surfaces around it alone', async () => {
    const { app } = makeApp(false);
    // Another plugin's task-scoped mounts (agents: ask/guide/approve-gate) are not intercepted — with no
    // plugin loaded here they fall through to a plain 404, i.e. our gate never spoke for them.
    for (const path of ['/tasks/t-1/ask', '/tasks/t-1/guide', '/tasks/t-1/approve-gate', '/tasksfoo']) {
      expect((await app.request(path)).status).toBe(404);
    }
    // Core surfaces that outlive the task domain keep serving: instance spend folds in chat usage, and
    // the maintenance wipe still clears the activity feed.
    expect((await app.request('/usage/by-model')).status).toBe(200);
    expect(await (await app.request('/usage/by-day')).json()).toEqual([]);
    const cleanup = await app.request('/admin/cleanup', { method: 'POST' });
    expect(cleanup.status).toBe(200);
    // …and it reports zero task rows rather than claiming it removed any.
    expect(await cleanup.json()).toMatchObject({ ok: true, tasks: 0, missions: 0 });
  });

  it('serves the same paths normally as soon as the domain has an owner', async () => {
    const { app } = makeApp(true);
    const list = await app.request('/tasks');
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([]);
    const created = await app.request('/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Real task' }),
    });
    expect(created.status).toBe(201);
    expect((await (await app.request('/tasks')).json() as unknown[])).toHaveLength(1);
  });
});
