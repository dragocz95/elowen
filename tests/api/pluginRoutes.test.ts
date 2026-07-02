import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function makePlugin(root: string, name: string) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'orca-plugin.json'), JSON.stringify({
    name, version: '1.0.0', apiVersion: '1', description: `${name} plugin`, entry: 'index.mjs',
    provides: { tools: [`${name}_tool`] },
  }));
  writeFileSync(join(dir, 'index.mjs'), 'export function register(){}');
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'orca-plugroutes-'));
  makePlugin(root, 'skills');
  makePlugin(root, 'files');
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw');
  const amy = users.create('amy', 'pw');
  const config = new ConfigStore(db);
  const reloadPlugins = vi.fn(async () => {});
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
    pluginDirs: [root],
    brain: { reloadPlugins } as never,
  });
  return { app, config, reloadPlugins, adminTok: users.issueToken(admin.id), amyTok: users.issueToken(amy.id) };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const patch = (t: string, body: unknown) => ({ method: 'PATCH', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('plugin routes', () => {
  it('lists discovered plugins with enabled flags (admin)', async () => {
    const { app, adminTok } = setup();
    const res = await app.request('/plugins', auth(adminTok));
    expect(res.status).toBe(200);
    const list = await res.json() as { name: string; enabled: boolean; provides: { tools?: string[] } }[];
    expect(list.map((p) => p.name).sort()).toEqual(['files', 'skills']);
    expect(list.every((p) => !p.enabled)).toBe(true);
    expect(list.find((p) => p.name === 'files')?.provides.tools).toEqual(['files_tool']);
  });

  it('PATCH toggles a plugin, persists config, and hot-reloads the brain', async () => {
    const { app, config, reloadPlugins, adminTok } = setup();
    const on = await app.request('/plugins/skills', patch(adminTok, { enabled: true }));
    expect(on.status).toBe(200);
    expect((await on.json() as { enabled: boolean }).enabled).toBe(true);
    expect(config.get().plugins.enabled).toEqual(['skills']);
    expect(reloadPlugins).toHaveBeenCalledTimes(1);
    const off = await app.request('/plugins/skills', patch(adminTok, { enabled: false }));
    expect((await off.json() as { enabled: boolean }).enabled).toBe(false);
    expect(config.get().plugins.enabled).toEqual([]);
  });

  it('rejects a non-admin (403) and an unknown plugin (404)', async () => {
    const { app, amyTok, adminTok } = setup();
    expect((await app.request('/plugins', auth(amyTok))).status).toBe(403);
    expect((await app.request('/plugins/skills', patch(amyTok, { enabled: true }))).status).toBe(403);
    expect((await app.request('/plugins/ghost', patch(adminTok, { enabled: true }))).status).toBe(404);
  });

  it('validates the enabled field (400)', async () => {
    const { app, adminTok } = setup();
    expect((await app.request('/plugins/skills', patch(adminTok, { enabled: 'yes' }))).status).toBe(400);
  });
});
