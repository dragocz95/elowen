import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
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
import { BrainOAuthManager } from '../../src/brain/oauth.js';
import { AuthStorage } from '@earendil-works/pi-coding-agent';

function makePlugin(root: string, name: string, extra: Record<string, unknown> = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'orca-plugin.json'), JSON.stringify({
    name, version: '1.0.0', apiVersion: '1', description: `${name} plugin`, entry: 'index.mjs',
    provides: { tools: [`${name}_tool`] }, ...extra,
  }));
  writeFileSync(join(dir, 'index.mjs'), 'export function register(){}');
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'orca-plugroutes-'));
  const dataRoot = mkdtempSync(join(tmpdir(), 'orca-plugdata-'));
  makePlugin(root, 'skills');
  makePlugin(root, 'files');
  makePlugin(root, 'discord', {
    configSchema: [
      { key: 'botToken', label: 'Bot token', type: 'secret', required: true },
      { key: 'guildId', label: 'Guild ID', type: 'string' },
      { key: 'rolePolicies', label: 'Role policies', type: 'rolePolicies' },
    ],
  });
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
    pluginDataRoot: dataRoot,
    brain: { reloadPlugins } as never,
    brainOauth: new BrainOAuthManager(AuthStorage.inMemory()),
  });
  return { app, config, reloadPlugins, dataRoot, adminTok: users.issueToken(admin.id), amyTok: users.issueToken(amy.id) };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const patch = (t: string, body: unknown) => ({ method: 'PATCH', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('plugin routes', () => {
  it('lists discovered plugins with enabled flags (admin)', async () => {
    const { app, adminTok } = setup();
    const res = await app.request('/plugins', auth(adminTok));
    expect(res.status).toBe(200);
    const list = await res.json() as { name: string; enabled: boolean; configurable: boolean; provides: { tools?: string[] } }[];
    expect(list.map((p) => p.name).sort()).toEqual(['discord', 'files', 'skills']);
    expect(list.every((p) => !p.enabled)).toBe(true);
    expect(list.find((p) => p.name === 'files')?.provides.tools).toEqual(['files_tool']);
    expect(list.find((p) => p.name === 'discord')?.configurable).toBe(true);
    expect(list.find((p) => p.name === 'files')?.configurable).toBe(false);
  });

  it('GET /plugins/:name returns the schema + values with secrets masked', async () => {
    const { app, adminTok } = setup();
    await app.request('/plugins/discord/config', patch(adminTok, { values: { botToken: 'tok-123', guildId: 'g1', rolePolicies: [{ roleId: 'r1', name: 'devs', projectIds: [1], prompt: 'Be nice.' }] } }));
    const res = await app.request('/plugins/discord', auth(adminTok));
    expect(res.status).toBe(200);
    const body = await res.json() as { config: Record<string, unknown>; secretsSet: string[]; configSchema: { key: string }[] };
    expect(body.configSchema.map((f) => f.key)).toEqual(['botToken', 'guildId', 'rolePolicies']);
    expect(body.config.guildId).toBe('g1');
    expect(body.config.botToken).toBeUndefined();
    expect(body.secretsSet).toEqual(['botToken']);
    expect(JSON.stringify(body)).not.toContain('tok-123');
  });

  it('PATCH config keeps a stored secret when the field arrives empty', async () => {
    const { app, config, adminTok } = setup();
    await app.request('/plugins/discord/config', patch(adminTok, { values: { botToken: 'tok-123' } }));
    await app.request('/plugins/discord/config', patch(adminTok, { values: { botToken: '', guildId: 'g2' } }));
    expect(config.pluginConfig('discord')).toMatchObject({ botToken: 'tok-123', guildId: 'g2' });
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

  it('lists a plugin health flag (defaults ok without a log buffer)', async () => {
    const { app, adminTok } = setup();
    const list = await (await app.request('/plugins', auth(adminTok))).json() as { name: string; health: string }[];
    expect(list.every((p) => p.health === 'ok')).toBe(true);
  });

  it('GET /plugins/:name includes a data summary', async () => {
    const { app, adminTok } = setup();
    const body = await (await app.request('/plugins/discord', auth(adminTok))).json() as { data: { exists: boolean; files: number; bytes: number } };
    expect(body.data).toEqual({ path: expect.any(String), exists: false, files: 0, bytes: 0 });
  });
});

describe('plugin contributions + logs + data routes', () => {
  it('GET /plugins/:name/contributions — admin 200, non-admin 403, unknown 404', async () => {
    const { app, adminTok, amyTok } = setup();
    const ok = await app.request('/plugins/discord/contributions', auth(adminTok));
    expect(ok.status).toBe(200);
    // No registry provider wired in this test → empty report (never a 500).
    expect(await ok.json()).toEqual({ tools: [], skills: [], platforms: [], promptFragments: [], turnContexts: [], hooks: [] });
    expect((await app.request('/plugins/discord/contributions', auth(amyTok))).status).toBe(403);
    expect((await app.request('/plugins/ghost/contributions', auth(adminTok))).status).toBe(404);
  });

  it('GET /plugins/:name/logs — admin 200 empty, non-admin 403, unknown 404', async () => {
    const { app, adminTok, amyTok } = setup();
    const ok = await app.request('/plugins/discord/logs', auth(adminTok));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ entries: [], health: 'ok' });
    expect((await app.request('/plugins/discord/logs', auth(amyTok))).status).toBe(403);
    expect((await app.request('/plugins/ghost/logs', auth(adminTok))).status).toBe(404);
  });

  it('POST /plugins/:name/data/clear wipes the plugin data dir contents', async () => {
    const { app, adminTok, amyTok, dataRoot } = setup();
    const dir = join(dataRoot, 'discord');
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(join(dir, 'a.txt'), 'x');
    writeFileSync(join(dir, 'nested', 'b.txt'), 'y');
    expect((await app.request('/plugins/discord/data/clear', { method: 'POST', headers: { authorization: `Bearer ${amyTok}` } })).status).toBe(403);
    const res = await app.request('/plugins/discord/data/clear', { method: 'POST', headers: { authorization: `Bearer ${adminTok}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(existsSync(dir)).toBe(true); // the dir itself stays
    expect(readdirSync(dir)).toEqual([]); // …but its contents are gone
  });

  it('POST /plugins/:name/data/clear refuses a name with a path separator (400) and leaves siblings intact', async () => {
    const { app, adminTok, dataRoot } = setup();
    const sibling = join(dataRoot, 'skills');
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'keep.txt'), 'z');
    // %2F decodes to a slash in the :name param → path guard must refuse it before touching disk.
    const res = await app.request('/plugins/..%2Fskills/data/clear', { method: 'POST', headers: { authorization: `Bearer ${adminTok}` } });
    expect(res.status).toBe(400);
    expect(existsSync(join(sibling, 'keep.txt'))).toBe(true);
  });
});

describe('brain oauth routes', () => {
  function oauthSetup() {
    const base = setup();
    return base;
  }

  it('status maps oauth types to connected flags (admin only)', async () => {
    const { app, adminTok, amyTok } = oauthSetup();
    expect((await app.request('/brain/oauth/status', auth(amyTok))).status).toBe(403);
    const res = await app.request('/brain/oauth/status', auth(adminTok));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ 'oauth-anthropic': false, 'oauth-github-copilot': false, 'oauth-openai-codex': false });
  });

  it('start rejects an unknown type (404)', async () => {
    const { app, adminTok } = oauthSetup();
    expect((await app.request('/brain/oauth/bogus/start', { method: 'POST', headers: { authorization: `Bearer ${adminTok}` } })).status).toBe(404);
  });
});
