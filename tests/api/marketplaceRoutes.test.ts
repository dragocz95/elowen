import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { MissionStore } from '../../src/store/missionStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { BrainOAuthManager } from '../../src/brain/oauth.js';
import { AuthStorage } from '@earendil-works/pi-coding-agent';
import { MarketplaceError } from '../../src/plugins/marketplace.js';

function setup(marketplace?: Record<string, unknown>) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw');
  const amy = users.create('amy', 'pw');
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db), users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
    pluginDirs: [], pluginDataRoot: '/tmp/none',
    brainOauth: new BrainOAuthManager(AuthStorage.inMemory()),
    marketplace: marketplace as never,
  });
  return { app, adminTok: users.issueToken(admin.id), amyTok: users.issueToken(amy.id) };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const post = (t: string) => ({ method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: '{}' });
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
    const { app, adminTok } = setup(undefined);
    for (const path of ['/plugins/marketplace']) {
      expect((await app.request(path, auth(adminTok))).status).toBe(503);
    }
    expect((await app.request('/plugins/marketplace/weather/install', post(adminTok))).status).toBe(503);
    expect((await app.request('/plugins/weather', del(adminTok))).status).toBe(503);
  });

  it('maps a MarketplaceError to its status (409 for a built-in)', async () => {
    const uninstall = vi.fn(async () => { throw new MarketplaceError('built-in', 409); });
    const { app, adminTok } = setup({ uninstall });
    const res = await app.request('/plugins/memory', del(adminTok));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'built-in' });
  });

  it('installs via POST and returns the updated listing shape', async () => {
    const install = vi.fn(async () => {});
    const { app, adminTok } = setup({ install });
    const res = await app.request('/plugins/marketplace/weather/install', post(adminTok));
    expect(res.status).toBe(200);
    expect(install).toHaveBeenCalledWith('weather', {});
  });
});
