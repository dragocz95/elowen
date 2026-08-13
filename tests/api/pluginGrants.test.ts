import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';
import { loadPlugins } from '../../src/plugins/loader.js';
import { PluginRegistryProvider } from '../../src/plugins/pluginsProvider.js';

let dirs: string[] = [];
const tmpDir = (tag: string): string => { const p = mkdtempSync(join(tmpdir(), `elowen-${tag}-`)); dirs.push(p); return p; };
afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });

/** A minimal plugin that opts into per-user grants: one root-mounted `access: 'user'` route echoing the
 *  identity the dispatcher established, one web bundle, and a per-user teardown handler that records the
 *  ids it was told about into a file (the only channel a loaded-in-process plugin has back to the test). */
function grantablePluginDir(opts: { userGrantable?: boolean } = {}): { dir: string; removedLog: string } {
  const root = tmpDir('grant-plugins');
  const dir = join(root, 'grantdemo');
  mkdirSync(join(dir, 'web'), { recursive: true });
  const removedLog = join(root, 'removed.log');
  writeFileSync(join(dir, 'elowen-plugin.json'), JSON.stringify({
    name: 'grantdemo', version: '1.0.0', apiVersion: '1', description: 'grant demo', entry: 'index.mjs',
    ...(opts.userGrantable === false ? {} : { userGrantable: true }),
    provides: { apiRoutes: ['/grantdemo'] },
    web: { entry: 'web/index.js', nav: [{ label: 'Grant demo', route: 'demo' }] },
  }));
  writeFileSync(join(dir, 'web', 'index.js'), 'export const ok = 1;\n');
  writeFileSync(join(dir, 'index.mjs'), `
import { appendFileSync } from 'node:fs';
export function register(ctx) {
  ctx.registerApiRoute({ rootMount: '/grantdemo', path: '', method: 'GET', access: 'user', handler: async (req) => {
    const id = ctx.currentIdentity();
    return { body: { ok: true, authUserId: req.auth.userId, identity: id } };
  } });
  ctx.registerUserRemoved((userId) => { appendFileSync(${JSON.stringify(removedLog)}, String(userId) + '\\n'); });
}
`);
  return { dir: root, removedLog };
}

function setup(opts: { userGrantable?: boolean } = {}) {
  const { dir: pluginsDir, removedLog } = grantablePluginDir(opts);
  const dataRoot = tmpDir('grant-data');
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw');
  const amy = users.create('amy', 'pw');
  const provider = new PluginRegistryProvider(() => loadPlugins({
    dirs: [pluginsDir], enabled: ['grantdemo'], dataRoot,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }));
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db), users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
    pluginDirs: [pluginsDir], pluginDataRoot: dataRoot,
    plugins: provider,
  });
  return { app, users, removedLog, admin, amy, adminTok: users.issueToken(admin.id), amyTok: users.issueToken(amy.id) };
}

const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const patch = (t: string, body: unknown) => ({ method: 'PATCH', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('per-user plugin grants', () => {
  it('refuses a grant-gated API route for a user without the grant, and serves it once granted', async () => {
    const { app, users, amy, adminTok, amyTok } = setup();
    expect((await app.request('/grantdemo', auth(adminTok))).status).toBe(200);
    expect((await app.request('/grantdemo', auth(amyTok))).status).toBe(403);
    users.setGrantedPlugins(amy.id, ['grantdemo']);
    expect((await app.request('/grantdemo', auth(amyTok))).status).toBe(200);
  });

  it('leaves a plugin that never opted in reachable by everyone', async () => {
    const { app, amyTok } = setup({ userGrantable: false });
    expect((await app.request('/grantdemo', auth(amyTok))).status).toBe(200);
  });

  it('hands the handler the caller identity through ctx.currentIdentity()', async () => {
    const { app, amy, users, amyTok } = setup();
    users.setGrantedPlugins(amy.id, ['grantdemo']);
    const body = await (await app.request('/grantdemo', auth(amyTok))).json() as {
      authUserId: number; identity: { platform: string; elowenUserId?: number; admin: boolean; owner: boolean };
    };
    expect(body.authUserId).toBe(amy.id);
    expect(body.identity.platform).toBe('http');
    expect(body.identity.elowenUserId).toBe(amy.id);
    expect(body.identity.admin).toBe(false);
    // The instance operator is the first admin, not this user.
    expect(body.identity.owner).toBe(false);
  });

  it('marks the first admin as the owner of an HTTP identity', async () => {
    const { app, adminTok } = setup();
    const body = await (await app.request('/grantdemo', auth(adminTok))).json() as { identity: { admin: boolean; owner: boolean } };
    expect(body.identity.admin).toBe(true);
    expect(body.identity.owner).toBe(true);
  });

  it('hides a grant-gated plugin from the UI listing and refuses its bundle', async () => {
    const { app, users, amy, adminTok, amyTok } = setup();
    const listFor = async (tok: string) => (await (await app.request('/plugins/ui', auth(tok))).json()) as { name: string; url: string }[];
    const adminList = await listFor(adminTok);
    expect(adminList.map((p) => p.name)).toContain('grantdemo');
    expect(await listFor(amyTok)).toEqual([]);

    const bundleUrl = adminList.find((p) => p.name === 'grantdemo')!.url;
    expect((await app.request(bundleUrl, auth(adminTok))).status).toBe(200);
    // Hiding the menu entry is worthless if the bundle itself is still downloadable by URL.
    expect((await app.request(bundleUrl, auth(amyTok))).status).toBe(403);

    users.setGrantedPlugins(amy.id, ['grantdemo']);
    expect((await listFor(amyTok)).map((p) => p.name)).toEqual(['grantdemo']);
    expect((await app.request(bundleUrl, auth(amyTok))).status).toBe(200);
  });

  it('clamps a grant patch to plugins that actually declare userGrantable', async () => {
    const { app, users, amy, adminTok } = setup();
    const res = await app.request(`/users/${amy.id}`, patch(adminTok, { granted_plugins: ['grantdemo', 'nope', 'files'] }));
    expect(res.status).toBe(200);
    expect(users.get(amy.id)!.granted_plugins).toEqual(['grantdemo']);
  });

  it('refuses a grant patch from a non-admin', async () => {
    const { app, users, amy, amyTok } = setup();
    expect((await app.request(`/users/${amy.id}`, patch(amyTok, { granted_plugins: ['grantdemo'] }))).status).toBe(403);
    expect(users.get(amy.id)!.granted_plugins).toEqual([]);
  });

  it('tells every plugin about a deleted account before the row is gone', async () => {
    const { app, users, amy, adminTok, removedLog } = setup();
    const res = await app.request(`/users/${amy.id}`, { method: 'DELETE', ...auth(adminTok) });
    expect(res.status).toBe(200);
    expect(users.get(amy.id)).toBeNull();
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(removedLog, 'utf8').trim().split('\n')).toEqual([String(amy.id)]);
  });
});
