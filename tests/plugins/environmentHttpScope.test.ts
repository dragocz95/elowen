import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp, pluginTestHost } from '../helpers/testApp.js';
import { loadPlugins } from '../../src/plugins/loader.js';
import { PluginRegistryProvider } from '../../src/plugins/pluginsProvider.js';
import { makePluginDb } from '../../src/store/pluginDb.js';
import { openDb } from '../../src/store/db.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { currentAccountUserId, runWithPolicy } from '../../src/plugins/policyContext.js';
import { currentAccess } from '../../src/plugins/pathGuard.js';
import { createEnvironmentRuntime } from '../../plugins/sandbox/lib/environmentRuntime.mjs';
import { initSandboxDb } from '../../plugins/sandbox/lib/db.mjs';
import type { Policy } from '../../src/plugins/policy.js';
import type { PluginContext } from '../../src/plugins/api.js';

const temps: string[] = [];
afterEach(() => { for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true }); });

const scratch = (prefix: string): string => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temps.push(path);
  return path;
};
const libUrl = (file: string) => pathToFileURL(resolve('plugins/sandbox/lib', file)).href;
const never = () => { throw new Error('the fixture never reaches a container'); };
const podman = { inspect: async () => null, ensureProjectImage: never, create: never, start: never, stop: never, remove: never, exec: never };
const storage = { prepare: never, snapshot: never, readSnapshot: never, restoreVolumes: never };

/** An on-disk plugin that mounts the REAL sandbox environment API over the REAL environment runtime, so a
 *  request travels the production path end to end: bearer auth → the core plugin API dispatcher →
 *  `runWithIdentity` → `registerEnvironmentApi`'s accessibleProjects gate → `authorize` → the real
 *  UserProjectStore. Only Podman is a stub; every authorization decision on the way is the shipped one. */
function sandboxFixture(dataDir: string): string {
  const root = scratch('env-http-plugin-');
  const dir = join(root, 'sandbox');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'elowen-plugin.json'), JSON.stringify({
    name: 'sandbox', version: '1.0.0', apiVersion: '1', description: 'environment scope fixture', entry: 'index.mjs',
    capabilities: { reads: ['db', 'stores'] },
    provides: { apiRoutes: ['projects', 'environments/status', 'environments/request', 'environments/operation', 'environments/snapshots', 'environments/logs', 'environments/files', 'environments/worktrees'] },
  }));
  writeFileSync(join(dir, 'index.mjs'), `
    import { initSandboxDb } from ${JSON.stringify(libUrl('db.mjs'))};
    import { createEnvironmentRuntime } from ${JSON.stringify(libUrl('environmentRuntime.mjs'))};
    import { registerEnvironmentApi } from ${JSON.stringify(libUrl('environmentApi.mjs'))};
    const never = () => { throw new Error('the fixture never reaches a container'); };
    export function register(ctx) {
      initSandboxDb(ctx);
      const runtime = createEnvironmentRuntime({
        ctx, db: ctx.db(), dataDir: ${JSON.stringify(dataDir)}, daemon: true,
        podman: { inspect: async () => null, ensureProjectImage: never, create: never, start: never, stop: never, remove: never, exec: never },
        storage: { prepare: never, snapshot: never, readSnapshot: never, restoreVolumes: never },
      });
      ctx.registerHook({ name: 'plugin.reload.before', run: () => runtime.dispose() });
      registerEnvironmentApi(ctx, runtime);
    }
  `);
  return root;
}

/** The app with two managed projects: `member` holds 12 only, `stranger` holds none, `admin` holds all. */
async function setup() {
  const dataDir = scratch('env-http-data-');
  const pluginRoot = sandboxFixture(dataDir);
  // loadPlugins runs lazily on the first request, by which point the app's own db and stores exist.
  const wiring: { pluginDb?: (name: string) => ReturnType<typeof makePluginDb>; host?: ReturnType<typeof pluginTestHost> } = {};
  const app = await makeTestApp({
    userProjects: true,
    extra: {
      plugins: new PluginRegistryProvider(() => loadPlugins({
        dirs: [pluginRoot], enabled: ['sandbox'], logger: { info() {}, warn() {}, error: (message: string) => console.error(message) },
        delegatedTurnsOutOfProcess: () => false,
        pluginDb: (name) => wiring.pluginDb!(name),
        host: wiring.host!,
      })),
    },
  });
  const projects = new ProjectStore(app.db);
  const userProjects = new UserProjectStore(app.db);
  for (const [id, slug] of [[12, 'personal-member'], [13, 'shared-managed']] as const) {
    app.db.prepare("INSERT INTO projects (id,slug,path,execution_kind,lifecycle) VALUES (?,?,'','managed','active')").run(id, slug);
  }
  const admin = app.deps.users.list()[0]!;
  const member = app.deps.users.create('member', 'pw');
  const stranger = app.deps.users.create('stranger', 'pw');
  userProjects.assign(member.id, 12);

  const base = pluginTestHost({ db: app.db, projects });
  wiring.pluginDb = (name) => makePluginDb(app.db, name, { canMigrate: true });
  wiring.host = {
    ...base,
    stores: {
      ...base.stores, projects, userProjects,
      usersRead: {
        list: () => app.deps.users.list().map((user) => ({ id: user.id })),
        isAdmin: (id: number) => app.deps.users.isAdmin(id),
        allowedExecs: () => null,
        mayUsePlugin: () => true,
      },
    },
  } as ReturnType<typeof pluginTestHost>;
  return { ...app, projects, userProjects, admin, member, stranger, wiring };
}

type App = Awaited<ReturnType<typeof setup>>;
const auth = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
const environment = async (app: App, id: number, token: string) => {
  const res = await app.app.request(`/plugins/sandbox/api/projects/${id}/environment`, auth(token));
  // A fixture that failed to load answers 404 for every caller, which would read as a passing refusal.
  if (res.status === 404) throw new Error('the sandbox fixture did not mount its API route');
  return res;
};

/** The same runtime the fixture mounts, wired to the REAL turn-scope readers — the shape a plugin tool
 *  runs in. Used for the in-turn half of the boundary, which no HTTP request can express. */
function turnRuntime(app: App) {
  // Its own database: the fixture's plugin instance already owns the environment tables in the app's.
  const sql = openDb(':memory:');
  const db = makePluginDb(sql, 'sandbox', { canMigrate: true });
  const ctx = {
    db: () => db, host: { stores: () => app.wiring.host!.stores }, currentAccess, currentAccountUserId, config: {},
  } as unknown as PluginContext;
  initSandboxDb(ctx);
  const runtime = createEnvironmentRuntime({ ctx, db, dataDir: scratch('env-turn-data-'), podman, storage, daemon: true });
  return runtime.control ?? runtime;
}

describe('managed project environment over the authenticated plugin API', () => {
  // The regression. An authenticated API request is an identity and not a turn, so `currentAccess()`
  // reports no project scope for anyone — and reading that as a turn's narrowing refused the project's own
  // members and every administrator with `project_scope`, which the editor then showed as an opaque 503.
  it('serves a member their own project', async () => {
    const app = await setup();
    const res = await environment(app, 12, app.deps.users.issueToken(app.member.id));
    expect(res.status).toBe(200);
    expect((await res.json() as { environment: { projectId: number; state: string } }).environment)
      .toMatchObject({ projectId: 12, state: 'unprovisioned' });
  });

  it('serves an administrator a project they are not assigned to', async () => {
    const app = await setup();
    expect((await environment(app, 13, app.deps.users.issueToken(app.admin.id))).status).toBe(200);
  });

  it('refuses a non-member, an anonymous caller and a member whose access was revoked', async () => {
    const app = await setup();
    expect((await environment(app, 13, app.deps.users.issueToken(app.member.id))).status).toBe(403);
    expect((await environment(app, 12, app.deps.users.issueToken(app.stranger.id))).status).toBe(403);
    expect((await app.app.request('/plugins/sandbox/api/projects/12/environment')).status).toBe(401);

    app.userProjects.unassign(app.member.id, 12);
    expect((await environment(app, 12, app.deps.users.issueToken(app.member.id))).status).toBe(403);
  });

  // The other half of the same boundary: inside a TURN the narrowing still applies, so a restricted agent
  // cannot reach a project outside its policy even when the acting account is an administrator.
  it('keeps narrowing a turn to its own policy scope', async () => {
    const app = await setup();
    await app.app.request('/plugins/sandbox/api/projects/12/environment', auth(app.deps.users.issueToken(app.admin.id)));
    const control = turnRuntime(app);
    const scoped: Policy = { allowedProjectIds: new Set([12]), allowedPaths: () => [] };
    const identity = { platform: 'web', userId: String(app.admin.id), elowenUserId: app.admin.id, admin: false, owner: true, conversation: 'own' as const };
    const call = (projectId: number) => runWithPolicy(scoped, () =>
      control.environmentFor({ project: { kind: 'managed', projectId }, accountUserId: app.admin.id }), { identity });
    await expect(call(13)).rejects.toMatchObject({ code: 'project_scope', status: 403 });
    await expect(call(12)).resolves.toMatchObject({ projectId: 12 });
  });
});
