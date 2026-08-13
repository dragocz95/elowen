import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
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
import { makePluginDb } from '../../src/store/pluginDb.js';
import { loadPlugins } from '../../src/plugins/loader.js';
import { PluginRegistryProvider } from '../../src/plugins/pluginsProvider.js';
import { agentsPluginProvider } from '../helpers/testApp.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';

/** The bundled plugin dir — DISCOVERABLE in both shapes below, so an unowned daemon still knows the
 *  task surface exists and is merely switched off (declared-but-inactive → 503, not a bare 404). */
const PLUGIN_DIRS = [join(process.cwd(), 'plugins')];

/** A daemon whose task domain either has an owner (the work plugin loaded) or has none (it is disabled).
 *  Which plugins are ENABLED is the ONLY difference — everything else is wired identically. */
async function makeApp(owned: boolean) {
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const config = new ConfigStore(db);
  const projects = new ProjectStore(db);
  const bus = new EventBus();
  const tasks = owned ? new TaskStore(db) : undefined;
  const provider = owned
    ? agentsPluginProvider({ db, tasks: tasks!, readiness: new Readiness(db), config, projects, bus })
    // Nothing enabled: the work plugin is on disk (so its mounts are declared) but owns nothing here.
    : new PluginRegistryProvider(() => loadPlugins({
      dirs: PLUGIN_DIRS,
      enabled: [],
      delegatedTurnsOutOfProcess: () => false,
      pluginDb: (plugin) => makePluginDb(db, plugin, { canMigrate: true }),
      publishEvent: (e) => bus.publish(e),
      subscribeEvents: (fn) => bus.subscribe(fn),
      logger: { info() {}, warn() {}, error() {} },
    }));
  const registry = await provider.get();
  const app = createServer({
    ...(tasks ? { tasks } : {}),
    taskRefs: new TaskRefs(db),
    missions: new MissionStore(db), bus, tmux: new FakeTmuxDriver(),
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, projects,
    plugins: provider, pluginDirs: PLUGIN_DIRS,
  });
  return { app, db, registry };
}

describe('the task API without an owner for the task domain', () => {
  // The dishonest failure this guards against is an EMPTY 200: with no store behind it, a task list
  // that answers `[]` tells the CLI, the web UI and a spawned agent "this instance has no tasks",
  // which is a different statement from "task tracking is off here".
  it('answers 503 — never an empty list — on every path of the task family', async () => {
    const { app } = await makeApp(false);
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
      expect(await res.json()).toEqual({ error: 'work plugin is disabled' });
    }
  });

  // The answer must be scoped to paths a plugin actually DECLARES. A neighbouring surface that merely
  // starts with the same word is nobody's, and must still say "no such endpoint".
  it('leaves the surfaces around it alone', async () => {
    const { app } = await makeApp(false);
    // The task-scoped mounts of the OTHER plugin (agents: ask/guide/approve-gate) are declared by that
    // plugin, which is switched off here too — so they get the platform's own "declared but inactive"
    // 503, naming the plugin that owns them. Not a 404: the endpoint exists, this daemon just has its
    // subsystem off. (Before the extraction this fixture answered 404 only because it wired no plugin
    // dirs at all, so nothing could tell the two states apart — the real daemon always has them.)
    for (const path of ['/tasks/t-1/ask', '/tasks/t-1/guide', '/tasks/t-1/approve-gate']) {
      const res = await app.request(path);
      expect(`${path} → ${res.status}`).toBe(`${path} → 503`);
      expect(await res.json()).toEqual({ error: 'agents plugin is disabled' });
    }
    // …while a path NO plugin declares stays a plain 404: '/tasksfoo' must not ride the '/tasks' mount.
    expect((await app.request('/tasksfoo')).status).toBe(404);
    // Core surfaces that outlive the task domain keep serving: instance spend folds in chat usage, and
    // the maintenance wipe still clears the activity feed.
    expect((await app.request('/usage/by-model')).status).toBe(200);
    expect(await (await app.request('/usage/by-day')).json()).toEqual([]);
    const cleanup = await app.request('/admin/cleanup', { method: 'POST' });
    expect(cleanup.status).toBe(200);
    // …and it reports zero task rows rather than claiming it removed any.
    expect(await cleanup.json()).toMatchObject({ ok: true, tasks: 0, missions: 0 });
  });

  // The list above is written by hand, so it can only prove the gate covers what somebody remembered
  // to put in it. This derives the family from the ROUTER — every path the task routes actually
  // register — so a route added tomorrow outside the gate's patterns turns this red instead of quietly
  // falling through to a bare 404, i.e. "no such endpoint" where "the plugin is off" belongs.
  it('covers every path the task routes register — not just the ones somebody listed', async () => {
    const owned = await makeApp(true);
    const registered = [...owned.registry.rootApiRoutes]
      .filter(([, entry]) => entry.plugin === 'work')
      .flatMap(([mount, entry]) => entry.routes.map((r) => ({ method: r.method ?? 'GET', path: mount })));
    owned.db.close();
    expect(registered.length).toBeGreaterThan(10); // the plugin really did register the family

    const { app, db } = await makeApp(false);
    try {
      for (const { method, path } of registered) {
        // A concrete request path for the pattern; the gate is path-shaped only, so any segment does.
        const concrete = path.replace(/:[A-Za-z0-9_]+/g, 'x');
        const res = await app.request(concrete, {
          method, headers: { 'content-type': 'application/json' },
          ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }),
        });
        expect(`${method} ${concrete} → ${res.status}`).toBe(`${method} ${concrete} → 503`);
      }
    } finally { db.close(); }
  });

  it('serves the same paths normally as soon as the domain has an owner', async () => {
    const { app } = await makeApp(true);
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
