import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { makeTestApp, agentsTestHost } from '../../helpers/testApp.js';
import { openPluginTablesDb } from '../../helpers/pluginTablesDb.js';
import { openWorkDb } from '../../helpers/workDb.js';
import { createServer } from '../../../src/api/server.js';
import { loadPlugins } from '../../../src/plugins/loader.js';
import { PluginRegistryProvider } from '../../../src/plugins/pluginsProvider.js';
import { makePluginDb } from '../../../src/store/pluginDb.js';
import { MissionStore } from '../../../plugins/agents/src/store/missionStore.js';
import { TaskStore } from '../../../plugins/work/src/store/taskStore.js';
import { Readiness } from '../../../plugins/work/src/store/readiness.js';
import { EventBus } from '../../../src/api/sse.js';
import { FakeClock } from '../../../src/shared/clock.js';
import { ConfigStore } from '../../../src/store/configStore.js';
import { UserStore } from '../../../src/store/userStore.js';
import { ProjectStore } from '../../../src/store/projectStore.js';

// `/integrations/cli-status` probes nine real binaries with --version (one of them boots a daemon to
// answer), the same cost the detector's own unit tests carry — the work is slow, not stuck.
vi.setConfig({ testTimeout: 30_000 });

const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });

/** A daemon that DISCOVERS the agents plugin on disk but runs with it disabled — the production shape
 *  on this instance. Its manifest-declared mounts must degrade to the explicit 503. */
function discoveredButDisabled() {
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw');
  const app = createServer({
    missions: new MissionStore(db), bus: new EventBus(), tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db), users, projects: new ProjectStore(db),
    plugins: new PluginRegistryProvider(() => loadPlugins({
      dirs: [join(process.cwd(), 'plugins')], enabled: [], logger: { info() {}, warn() {}, error() {} },
    })),
    pluginDirs: [join(process.cwd(), 'plugins')],
  });
  return { app, token: users.issueToken(admin.id) };
}

/** A daemon whose agents plugin is LOADED with `slice` as its own config (plugins.config.agents). The
 *  slice is handed to a plugin at load — a config PATCH reloads the plugin, which is how an edit
 *  applies live — so seeing a slice value means loading with it, exactly as the daemon does. */
function appWithPluginConfig(slice: Record<string, unknown>) {
  const db = openWorkDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const config = new ConfigStore(db);
  config.update({ plugins: { config: { agents: slice } } });
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw');
  const tasks = new TaskStore(db);
  const readiness = new Readiness(db);
  const projects = new ProjectStore(db);
  const bus = new EventBus();
  const app = createServer({
    tasks, missions: new MissionStore(db), bus, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, users, projects,
    plugins: new PluginRegistryProvider(() => loadPlugins({
      dirs: [join(process.cwd(), 'plugins')], enabled: ['agents', 'work'],
      logger: { info() {}, warn() {}, error() {} },
      delegatedTurnsOutOfProcess: () => false,
      pluginDb: (plugin) => makePluginDb(db, plugin, { canMigrate: true }),
      publishEvent: (e) => bus.publish(e),
      subscribeEvents: (fn) => bus.subscribe(fn),
      // The daemon reads these from the settings row; the harness passes the same slices through.
      config: config.get().plugins?.config ?? { agents: slice },
      host: agentsTestHost({ db, tasks, readiness, config, projects, users }),
    })),
  });
  return { app, token: users.issueToken(admin.id) };
}

describe('GET /integrations/cli-status (agents plugin root mount)', () => {
  it('serves the detector payload while the plugin is loaded', async () => {
    const { app, token } = await makeTestApp();
    const res = await app.request('/integrations/cli-status', auth(token));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      tools: { name: string; installed: boolean; functional: boolean; version: string | null }[];
      summary: { allInstalled: boolean; allFunctional: boolean };
      freshInstall: { noConfigPersisted: boolean; noApiKey: boolean; noCustomSetup: boolean };
    };
    expect(body.tools).toHaveLength(9);
    expect(typeof body.summary.allInstalled).toBe('boolean');
    // node is what this suite runs on, so it is installed and functional by construction.
    const node = body.tools.find((t) => t.name === 'node')!;
    expect(node).toMatchObject({ installed: true, functional: true });
    expect(typeof node.version).toBe('string');
  });

  it('reads the fresh-install signals through the host config seam', async () => {
    // No settings row was ever written by this app → a fresh install in every signal.
    const fresh = await makeTestApp();
    const before = await (await fresh.app.request('/integrations/cli-status', auth(fresh.token))).json() as {
      freshInstall: { noConfigPersisted: boolean; noApiKey: boolean; noCustomSetup: boolean };
    };
    expect(before.freshInstall).toEqual({ noConfigPersisted: true, noApiKey: true, noCustomSetup: true });

    // A persisted relay key flips both the config-row and the api-key signal.
    const configured = await makeTestApp({ apiKey: 'sk-set' });
    const after = await (await configured.app.request('/integrations/cli-status', auth(configured.token))).json() as {
      freshInstall: { noConfigPersisted: boolean; noApiKey: boolean };
    };
    expect(after.freshInstall.noConfigPersisted).toBe(false);
    expect(after.freshInstall.noApiKey).toBe(false);
  });

  it('answers the declared-inactive 503 when the plugin is disabled', async () => {
    const { app, token } = discoveredButDisabled();
    const res = await app.request('/integrations/cli-status', auth(token));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'agents plugin is disabled' });
  });
});

describe('GET /integrations/github-status (agents plugin root mount)', () => {
  it('reports no token when the plugin has none configured', async () => {
    const { app, token } = await makeTestApp();
    const res = await app.request('/integrations/github-status', auth(token));
    expect(res.status).toBe(200);
    const body = await res.json() as { tokenSet: boolean; method: string; ready: boolean };
    expect(body.tokenSet).toBe(false);
    // Without a token the posture is whatever gh says on this machine — never the token method.
    expect(body.method).not.toBe('token');
  });

  it('reads the token from the plugin config slice and never returns its value', async () => {
    const { app, token } = appWithPluginConfig({ ghToken: 'ghp_slice_secret' });
    const res = await app.request('/integrations/github-status', auth(token));
    const body = await res.json() as { tokenSet: boolean; ready: boolean; method: string };
    expect(body).toMatchObject({ tokenSet: true, ready: true, method: 'token' });
    expect(JSON.stringify(body)).not.toContain('ghp_slice_secret');
  });

  it('still honours the legacy top-level token (pre-migration rollback path)', async () => {
    const { app, token, deps } = await makeTestApp();
    deps.config.update({ autopilot: { ghToken: 'ghp_legacy_secret' } });
    const body = await (await app.request('/integrations/github-status', auth(token))).json() as { tokenSet: boolean; method: string };
    expect(body).toMatchObject({ tokenSet: true, method: 'token' });
  });

  it('answers the declared-inactive 503 when the plugin is disabled', async () => {
    const { app, token } = discoveredButDisabled();
    const res = await app.request('/integrations/github-status', auth(token));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'agents plugin is disabled' });
  });
});
