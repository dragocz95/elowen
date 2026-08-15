import { describe, it, expect } from 'vitest';
import { TaskRefs } from '../../src/store/taskRefs.js';
import { TaskStore } from '../../plugins/work/src/store/taskStore.js';
import { Readiness } from '../../plugins/work/src/store/readiness.js';
import { MissionStore } from '../../plugins/agents/src/store/missionStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { loadPlugins } from '../../src/plugins/loader.js';
import { PluginRegistryProvider } from '../../src/plugins/pluginsProvider.js';
import { makePluginDb } from '../../src/store/pluginDb.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';
import { agentsTestHost } from '../helpers/testApp.js';
import type { MarketplaceService } from '../../src/plugins/marketplace.js';

/** A plugin that is ENABLED in config but present in no plugin directory — the state a host lands in
 *  when a subsystem has moved out of the npm package into the registry and the boot reconciler could not
 *  reach the registry to reinstall it.
 *
 *  Nothing on disk declares the mounts any more, so the dispatcher has no manifest to learn them from
 *  and every request falls through to a bare 404 — an answer that says "this endpoint never existed"
 *  about a subsystem the user's data still lives in. The mounts are therefore recovered from the
 *  marketplace's registry cache so the answer becomes an explicit 503 instead.
 */
function setup(opts: { enabled: string[]; cachedRoutes?: Record<string, string[]> }) {
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw');
  const config = new ConfigStore(db);
  config.update({ plugins: { enabled: opts.enabled } });
  const tasks = new TaskStore(db);
  const readiness = new Readiness(db);
  const projects = new ProjectStore(db);
  const bus = new EventBus();

  // Load NOTHING: no plugin dir is scanned, so no manifest on disk declares any mount. That is exactly
  // the "enabled but not installed" shape this file is about.
  const plugins = new PluginRegistryProvider(() => loadPlugins({
    dirs: [], enabled: opts.enabled, logger: { info() {}, warn() {}, error() {} },
    delegatedTurnsOutOfProcess: () => false,
    pluginDb: (plugin) => makePluginDb(db, plugin, { canMigrate: true }),
    publishEvent: (e) => bus.publish(e),
    subscribeEvents: (fn) => bus.subscribe(fn),
    host: agentsTestHost({ db, tasks, readiness, config, projects, users, bus }),
  }));

  // Stands in for the cloned registry on disk. Returning [] for an unknown name is the real method's
  // behaviour on a cache miss, and the tests below depend on that being faithful.
  const marketplace = {
    declaredRootRoutes: (name: string) => opts.cachedRoutes?.[name] ?? [],
  } as unknown as MarketplaceService;

  const app = createServer({
    tasks, taskRefs: new TaskRefs(db), missions: new MissionStore(db), bus,
    tmux: new FakeTmuxDriver() as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, users, projects, userProjects: new UserProjectStore(db),
    plugins, marketplace, pluginDirs: [],
  } as never);
  const tok = users.issueToken(admin.id);
  return { app, tok };
}

const auth = (tok: string) => ({ headers: { authorization: `Bearer ${tok}` } });

describe('a plugin that is enabled but not installed', () => {
  it('answers 503 and says the plugin is not installed, not merely off', async () => {
    const { app, tok } = setup({ enabled: ['work'], cachedRoutes: { work: ['/tasks'] } });
    const res = await app.request('/tasks', auth(tok));
    expect(res.status).toBe(503);
    // The wording carries the diagnosis: "disabled" is a switch the user can flip, "not installed"
    // means the code is absent from this host and no amount of toggling will help.
    expect(await res.json()).toEqual({ error: 'work plugin is enabled but not installed' });
  });

  it('covers sub-paths of the recovered mount, not just its root', async () => {
    const { app, tok } = setup({ enabled: ['work'], cachedRoutes: { work: ['/tasks'] } });
    expect((await app.request('/tasks/t1', auth(tok))).status).toBe(503);
  });

  it('still answers 404 when the registry cache knows nothing about the plugin', async () => {
    // The opposite direction, and the one that keeps this feature honest: without it the code could
    // answer 503 for every unmatched path in the daemon and this file would still be green.
    const { app, tok } = setup({ enabled: ['work'] });
    expect((await app.request('/tasks', auth(tok))).status).toBe(404);
  });

  it('does not claim a mount for a plugin that is not enabled', async () => {
    // A plugin the user switched off and never installed owns nothing; its paths must stay 404 so an
    // uninstalled optional feature cannot masquerade as a temporarily broken one.
    const { app, tok } = setup({ enabled: [], cachedRoutes: { work: ['/tasks'] } });
    expect((await app.request('/tasks', auth(tok))).status).toBe(404);
  });

  it('leaves unrelated unmatched paths at 404', async () => {
    const { app, tok } = setup({ enabled: ['work'], cachedRoutes: { work: ['/tasks'] } });
    expect((await app.request('/no-such-thing', auth(tok))).status).toBe(404);
  });
});
