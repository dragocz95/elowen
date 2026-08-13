import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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

const pluginsDir = join(process.cwd(), 'plugins');

// The '/plugins/whatsapp/pairing|pair|unpair' surface is served by the REAL whatsapp plugin (root
// mounts) off its live adapter instance; the adapter is constructed but never connected here.
function setup(opts: { enabled?: string[] } = {}) {
  const dataRoot = tmpDir('wapair');
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw');
  const amy = users.create('amy', 'pw');
  const provider = new PluginRegistryProvider(() => loadPlugins({
    dirs: [pluginsDir], enabled: opts.enabled ?? ['whatsapp'], dataRoot,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }));
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db), users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
    pluginDataRoot: dataRoot, pluginDirs: [pluginsDir],
    plugins: provider,
  });
  return { app, adminTok: users.issueToken(admin.id), amyTok: users.issueToken(amy.id) };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const post = (t: string) => ({ method: 'POST', headers: { authorization: `Bearer ${t}` } });

describe('whatsapp pairing routes', () => {
  it('GET /plugins/whatsapp/pairing reads the live adapter state (unpaired here)', async () => {
    const { app, adminTok } = setup();
    const res = await app.request('/plugins/whatsapp/pairing', auth(adminTok));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ qrImage: null, code: null, connected: false });
  });

  it('rejects a non-admin (403) on pairing, pair and unpair', async () => {
    const { app, amyTok } = setup();
    expect((await app.request('/plugins/whatsapp/pairing', auth(amyTok))).status).toBe(403);
    expect((await app.request('/plugins/whatsapp/pair', post(amyTok))).status).toBe(403);
    expect((await app.request('/plugins/whatsapp/unpair', post(amyTok))).status).toBe(403);
  });

  it('answers 503 "whatsapp plugin is disabled" when the plugin is off', async () => {
    const { app, adminTok } = setup({ enabled: [] });
    const res = await app.request('/plugins/whatsapp/pairing', auth(adminTok));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'whatsapp plugin is disabled' });
    expect((await app.request('/plugins/whatsapp/pair', post(adminTok))).status).toBe(503);
  });
});
