import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { BrainOAuthManager } from '../../src/brain/oauth.js';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { inMemoryModelRuntime } from '../../src/brain/providers.js';
import type { BrainCredentialAccess } from '../../src/brain/providerUsage.js';
import { MarketplaceError } from '../../src/plugins/marketplace.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';
import { RefMissions, RefReadiness, RefTaskStore } from '../helpers/refStores.js';

const noCreds: BrainCredentialAccess = { get: () => undefined, getApiKey: async () => undefined };
let sharedRuntime: ModelRuntime;
beforeAll(async () => { sharedRuntime = await inMemoryModelRuntime(); });

/** Write a minimal valid plugin manifest into `<dir>/<name>/elowen-plugin.json` so discoverPlugins finds it. */
function writePlugin(dir: string, name: string, extra: Record<string, unknown> = {}): void {
  const pdir = join(dir, name);
  mkdirSync(pdir, { recursive: true });
  writeFileSync(join(pdir, 'elowen-plugin.json'), JSON.stringify({ name, version: '1.0.0', apiVersion: '1', description: 'x', entry: 'index.mjs', ...extra }));
}

let dirs: string[] = [];
const tmpDir = (tag: string): string => { const p = mkdtempSync(join(tmpdir(), `elowen-${tag}-`)); dirs.push(p); return p; };
afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });

/** Lay out a bundled scan root (memory) + a user scan root (weather) so DELETE can branch on `source`. */
function pluginDirsFixture(): string[] {
  const base = tmpDir('mp');
  const bundled = join(base, 'bundled');
  const user = join(base, 'user');
  writePlugin(bundled, 'memory');
  writePlugin(user, 'weather');
  return [bundled, user];
}

function setup(marketplace?: Record<string, unknown>, pluginDirs: string[] = []) {
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw');
  const amy = users.create('amy', 'pw');
  const config = new ConfigStore(db);
  const app = createServer({
    tasks: new RefTaskStore(db), readiness: new RefReadiness(db), missions: new RefMissions(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
    pluginDirs, pluginDataRoot: '/tmp/none',
    brainOauth: new BrainOAuthManager(sharedRuntime, noCreds),
    marketplace: marketplace as never,
  });
  return { app, config, adminTok: users.issueToken(admin.id), amyTok: users.issueToken(amy.id) };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const post = (t: string) => ({ method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: '{}' });
const postBody = (t: string, body: unknown) => ({ method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const del = (t: string) => ({ method: 'DELETE', headers: { authorization: `Bearer ${t}` } });

describe('marketplace routes', () => {
  it('returns the catalog to an admin', async () => {
    const catalog = vi.fn(async () => ({ plugins: [{ name: 'weather', version: '1.0.0', description: 'x', status: 'available' }] }));
    const { app, adminTok } = setup({ catalog });
    const res = await app.request('/plugins/marketplace', auth(adminTok));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ plugins: [{ name: 'weather' }] });
  });

  it('forbids a non-admin (403)', async () => {
    const { app, amyTok } = setup({ catalog: vi.fn() });
    const res = await app.request('/plugins/marketplace', auth(amyTok));
    expect(res.status).toBe(403);
  });

  it('degrades to 503 when the marketplace service is unwired', async () => {
    const { app, adminTok } = setup(undefined, pluginDirsFixture());
    expect((await app.request('/plugins/marketplace', auth(adminTok))).status).toBe(503);
    expect((await app.request('/plugins/marketplace/weather/install', post(adminTok))).status).toBe(503);
    // A user plugin's uninstall needs the marketplace service; without it → 503.
    expect((await app.request('/plugins/weather', del(adminTok))).status).toBe(503);
  });

  it('soft-removes a bundled plugin (200) without touching the marketplace, and restores it', async () => {
    const uninstall = vi.fn(async () => {});
    const { app, config, adminTok } = setup({ uninstall }, pluginDirsFixture());
    // DELETE a bundled plugin: hidden + dropped from enabled, files kept, marketplace NOT called.
    config.update({ plugins: { enabled: ['memory'] } });
    const res = await app.request('/plugins/memory', del(adminTok));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ removed: true });
    expect(uninstall).not.toHaveBeenCalled();
    expect(config.get().plugins.removed).toContain('memory');
    expect(config.get().plugins.enabled).not.toContain('memory');
    // Restore drops it from `removed` again.
    const restored = await app.request('/plugins/memory/restore', post(adminTok));
    expect(restored.status).toBe(200);
    expect(config.get().plugins.removed).not.toContain('memory');
  });

  it('uninstalls a user plugin via the marketplace service', async () => {
    const uninstall = vi.fn(async () => {});
    const { app, adminTok } = setup({ uninstall }, pluginDirsFixture());
    const res = await app.request('/plugins/weather', del(adminTok));
    expect(res.status).toBe(200);
    expect(uninstall).toHaveBeenCalledWith('weather');
  });

  it('maps a MarketplaceError from a user-plugin uninstall to its status', async () => {
    const uninstall = vi.fn(async () => { throw new MarketplaceError('nope', 409); });
    const { app, adminTok } = setup({ uninstall }, pluginDirsFixture());
    const res = await app.request('/plugins/weather', del(adminTok));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'nope' });
  });

  it('404s deleting a plugin that is not on disk', async () => {
    const { app, adminTok } = setup({ uninstall: vi.fn() }, pluginDirsFixture());
    expect((await app.request('/plugins/ghost', del(adminTok))).status).toBe(404);
  });

  it('installs via POST and returns the updated listing shape', async () => {
    const install = vi.fn(async () => {});
    const { app, config, adminTok } = setup({ install });
    const res = await app.request('/plugins/marketplace/weather/install', post(adminTok));
    expect(res.status).toBe(200);
    // The route lands it inert and enables it itself, so the enable meets the same gate as the toggle.
    expect(install).toHaveBeenCalledWith('weather', { enable: false });
    expect(config.get().plugins.enabled).toContain('weather');
  });

  // One-click install was the way around the consent gate: it enabled by default and asked nothing, so a
  // registry plugin could claim power over memory or the live workflow DAG and get it from one POST.
  it('refuses to enable an installed plugin whose declared powers were not acknowledged', async () => {
    const base = tmpDir('mp-grants');
    const user = join(base, 'user');
    writePlugin(user, 'weather', { capabilities: { mutates: ['prompt', 'memory', 'workflow-dag'] } });
    const install = vi.fn(async () => {});
    const { app, config, adminTok } = setup({ install }, [user]);

    const bare = await app.request('/plugins/marketplace/weather/install', post(adminTok));
    expect(bare.status).toBe(409);
    // `installed: true` is the honest part: the folder IS on disk, it just is not switched on.
    expect(await bare.json()).toEqual({ error: 'grants require consent', grants: ['memory', 'workflow-dag'], installed: true });
    expect(install).toHaveBeenCalledWith('weather', { enable: false });
    expect(config.get().plugins.enabled).not.toContain('weather');

    const partial = await app.request('/plugins/marketplace/weather/install', postBody(adminTok, { acknowledgeGrants: ['memory'] }));
    expect(partial.status).toBe(409);
    expect(config.get().plugins.enabled).not.toContain('weather');

    const full = await app.request('/plugins/marketplace/weather/install', postBody(adminTok, { acknowledgeGrants: ['memory', 'workflow-dag'] }));
    expect(full.status).toBe(200);
    expect(config.get().plugins.enabled).toContain('weather');
  });

  it('installs without asking when the caller does not want it enabled', async () => {
    const base = tmpDir('mp-noenable');
    const user = join(base, 'user');
    writePlugin(user, 'weather', { capabilities: { mutates: ['memory'] } });
    const install = vi.fn(async () => {});
    const { app, config, adminTok } = setup({ install }, [user]);

    // Nothing is being handed over yet, so there is nothing to consent to.
    const res = await app.request('/plugins/marketplace/weather/install', postBody(adminTok, { enable: false }));
    expect(res.status).toBe(200);
    expect(config.get().plugins.enabled).not.toContain('weather');
  });
});
