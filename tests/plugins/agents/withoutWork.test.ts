import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { openAgentsDb } from '../../helpers/agentsDb.js';
import { agentsTestHost } from '../../helpers/testApp.js';
import { makePluginDb } from '../../../src/store/pluginDb.js';
import { loadPlugins } from '../../../src/plugins/loader.js';
import { PluginRegistryProvider } from '../../../src/plugins/pluginsProvider.js';
import { createServer } from '../../../src/api/server.js';
import { ConfigStore } from '../../../src/store/configStore.js';
import { ProjectStore } from '../../../src/store/projectStore.js';
import { UserStore } from '../../../src/store/userStore.js';
import { TaskRefs } from '../../../src/store/taskRefs.js';
import { EventBus } from '../../../src/api/sse.js';
import { FakeClock } from '../../../src/shared/clock.js';
import { FakeTmuxDriver } from '../../../src/tmux/fakeDriver.js';
import type { AgentsMissions } from '../../../src/plugins/api.js';
import type { TaskStore } from '../../../plugins/work/src/store/taskStore.js';
import type { Readiness } from '../../../plugins/work/src/store/readiness.js';

/** A missions subsystem whose task domain has NO owner: the `agents` plugin is enabled, the plugin that
 *  owns tasks is not. Missions are epics with phases, so this is a real dependency the plugin cannot
 *  fake — and the failure it must not have is the quiet one: half a runtime, an empty mission list
 *  presented as fact, or a 500 from a construction that could never have succeeded.
 *
 *  Composed exactly like the daemon: the seam throws (brainCore's tasksSeam) and answers
 *  `tasksAvailable() === false`, core reads missions through the live control the way bootstrap does. */
async function makeInstanceWithoutWork(enabled: string[] = ['agents']) {
  const db = openAgentsDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const config = new ConfigStore(db);
  const projects = new ProjectStore(db);
  const users = new UserStore(db);
  users.create('admin', 'pw');
  const token = users.issueToken(users.list()[0]!.id);
  const bus = new EventBus();
  const owned = enabled.includes('work');

  const base = agentsTestHost({ db, tasks: {} as TaskStore, readiness: {} as Readiness, config, projects, users });
  // brainCore's seam, verbatim in shape: reading the domain while nothing owns it THROWS (it must never
  // answer "no tasks" from a table core can still see), and `tasksAvailable()` is the question a
  // dependent plugin is expected to ask first.
  const unavailable = () => { throw new Error('the tasks domain is unavailable — no loaded plugin owns it'); };
  const host = {
    ...base,
    stores: {
      ...base.stores,
      get tasks() { return owned ? base.stores.tasks : unavailable(); },
      get readiness() { return owned ? base.stores.readiness : unavailable(); },
      get taskUsage() { return owned ? base.stores.taskUsage : unavailable(); },
      tasksAvailable: () => owned,
    },
  };

  const provider = new PluginRegistryProvider(() => loadPlugins({
    dirs: [join(process.cwd(), 'plugins')],
    enabled,
    delegatedTurnsOutOfProcess: () => false,
    pluginDb: (plugin) => makePluginDb(db, plugin, { canMigrate: true }),
    publishEvent: (e) => bus.publish(e),
    subscribeEvents: (fn) => bus.subscribe(fn),
    host: host as never,
    logger: { info() {}, warn() {}, error() {} },
  }));
  const registry = await provider.get();

  // bootstrap.ts's own mission facade, copied in shape: every read resolves the control LIVE and
  // degrades when it is absent. This is the code path that turns an unresolvable subsystem into an
  // honest core degradation instead of an exception inside a core route.
  const missionsControl = () => registry.control('missions');
  const missions: AgentsMissions = {
    get: (id) => missionsControl()?.missions().get(id) ?? null,
    active: () => missionsControl()?.missions().active() ?? [],
    live: () => missionsControl()?.missions().live() ?? [],
    activeForEpic: (epicId) => missionsControl()?.missions().activeForEpic(epicId) ?? null,
  };
  const app = createServer({
    taskRefs: new TaskRefs(db), missions, bus, tmux: new FakeTmuxDriver(),
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, users, projects, plugins: provider,
    get engine() { return missionsControl()?.engine(); },
    get advisor() { return missionsControl()?.advisor(); },
  });
  return { app, db, registry, missions, token, auth: { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } } };
}

describe('the agents plugin without the plugin that owns tasks', () => {
  it('is unreachable through its control — core degrades as it does for a disabled plugin', async () => {
    const { registry, missions, db } = await makeInstanceWithoutWork();
    try {
      // The plugin IS loaded (its routes, tools and readiness row all registered)…
      expect(registry.tools.some((t) => t.name === 'ElowenListMissions')).toBe(true);
      // …but the control it registered declares the domain it is built on, so it does not resolve while
      // that domain has no owner. Every bootstrap getter (engine, missionGit, planFlow, onTaskClosed,
      // advisor, …) hangs off this one call.
      expect(registry.control('missions')).toBeUndefined();
      // Which means core's own facades answer instead of throwing halfway through a request. The login
      // hook is the sharpest one: `void d.advisor?.ensureOnLogin(id)` is fire-and-forget, so a rejected
      // promise there is an unhandled rejection on every single login.
      expect(() => missions.live()).not.toThrow();
      expect(missions.live()).toEqual([]);
      expect(missions.get('m-1')).toBeNull();
    } finally { db.close(); }
  });

  it('resolves again the moment the domain has an owner', async () => {
    const { registry, db } = await makeInstanceWithoutWork(['agents', 'work']);
    try {
      expect(registry.control('tasks')).toBeDefined();
      expect(registry.control('missions')).toBeDefined();
    } finally { db.close(); }
  });

  it('answers 503 with the reason on its own mounts, and writes nothing', async () => {
    const { app, db, auth } = await makeInstanceWithoutWork();
    try {
      for (const [method, path] of [['GET', '/missions'], ['POST', '/missions'], ['GET', '/sessions'], ['GET', '/asks/pending']] as [string, string][]) {
        const res = await app.request(path, { method, ...auth, ...(method === 'POST' ? { body: JSON.stringify({ epicId: 'e-1' }) } : {}) });
        expect(`${method} ${path} → ${res.status}`).toBe(`${method} ${path} → 503`);
        // Not a bare "unavailable": the operator has to be able to tell WHICH switch to flip.
        expect((await res.json() as { error: string }).error).toMatch(/built on task tracking, whose plugin is disabled/);
      }
      // An engage attempt that answers 503 must not have created the mission it refused to run.
      expect((db.prepare('SELECT COUNT(*) AS n FROM missions').get() as { n: number }).n).toBe(0);
    } finally { db.close(); }
  });

  it('keeps serving the surface that owes tasks nothing', async () => {
    // Precision matters: gating the whole plugin would take the skills API down with it, which reads
    // files and has no task in it anywhere.
    const { app, db, auth } = await makeInstanceWithoutWork();
    try {
      expect((await app.request('/system/skills', auth)).status).toBe(200);
    } finally { db.close(); }
  });

  it('says so in the readiness row instead of offering a credential that changes nothing', async () => {
    const { registry, db } = await makeInstanceWithoutWork();
    try {
      const rows = await Promise.all(registry.readinessChecks.map((c) => c.fn()));
      const missionsRow = rows.find((r) => r?.id === 'missions');
      expect(missionsRow?.ok).toBe(false);
      expect(missionsRow?.detail).toBe('task tracking is disabled');
    } finally { db.close(); }
  });

  it('runs its boot reconciles and starts its services without throwing', async () => {
    const { registry, db } = await makeInstanceWithoutWork();
    try {
      for (const r of registry.bootReconciles) await r.fn();
      const deriver = registry.services.find((s) => s.service.name === 'deriver');
      expect(deriver).toBeDefined();
      expect(() => deriver!.service.start()).not.toThrow();
      deriver!.service.stop();
    } finally { db.close(); }
  });

  it('resolves event tenancy to admin-only rather than exploding in the bus', async () => {
    const { registry, db } = await makeInstanceWithoutWork();
    try {
      const resolver = registry.eventProjectResolvers.find((r) => r.plugin === 'agents');
      expect(resolver).toBeDefined();
      expect(resolver!.fn({ type: 'signal', session: 'elowen-w1', kind: 'idle', ts: 0 } as never)).toBeNull();
    } finally { db.close(); }
  });
});
