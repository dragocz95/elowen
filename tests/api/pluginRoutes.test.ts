import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { loadPlugins } from '../../src/plugins/loader.js';
import { PluginRegistryProvider } from '../../src/plugins/pluginsProvider.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';
import { makeSubagentCatalog } from '../../src/brain/agents/catalogService.js';
import { promptsPath } from '../../src/prompts/index.js';

let dirs: string[] = [];
const tmpDir = (tag: string): string => { const p = mkdtempSync(join(tmpdir(), `elowen-${tag}-`)); dirs.push(p); return p; };
afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });

const noCreds: BrainCredentialAccess = { get: () => undefined, getApiKey: async () => undefined };
let sharedRuntime: ModelRuntime;
beforeAll(async () => { sharedRuntime = await inMemoryModelRuntime(); });

function makePlugin(root: string, name: string, extra: Record<string, unknown> = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'elowen-plugin.json'), JSON.stringify({
    name, version: '1.0.0', apiVersion: '1', description: `${name} plugin`, entry: 'index.mjs',
    provides: { tools: [`${name}_tool`] }, ...extra,
  }));
  writeFileSync(join(dir, 'index.mjs'), 'export function register(){}');
}

function setup() {
  const root = tmpDir('plugroutes');
  const dataRoot = tmpDir('plugdata');
  makePlugin(root, 'skills');
  makePlugin(root, 'files');
  // Claims two powers that outlive a turn (stored memory, the live workflow DAG) plus one that does not
  // (`prompt`), so the consent tests can prove the line is drawn by REACH and not by "declares anything".
  makePlugin(root, 'risky', { capabilities: { mutates: ['prompt', 'memory', 'workflow-dag'] } });
  makePlugin(root, 'discord', {
    configSchema: [
      { key: 'botToken', label: 'Bot token', type: 'secret', required: true },
      { key: 'guildId', label: 'Guild ID', type: 'string' },
      { key: 'historyLimit', label: 'History', type: 'number', default: 25 },
      { key: 'rolePolicies', label: 'Role policies', type: 'rolePolicies' },
    ],
  });
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw');
  const amy = users.create('amy', 'pw');
  const config = new ConfigStore(db);
  // The brain reports whether the live registry swap happened; `false` means the change is persisted but
  // deferred until running work settles (see the 202 case below).
  const reloadPlugins = vi.fn(async () => true);
  const app = createServer({
    bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
    pluginDirs: [root],
    pluginDataRoot: dataRoot,
    brain: { reloadPlugins } as never,
    brainOauth: new BrainOAuthManager(sharedRuntime, noCreds),
  });
  return { app, config, reloadPlugins, dataRoot, adminTok: users.issueToken(admin.id), amyTok: users.issueToken(amy.id) };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const patch = (t: string, body: unknown) => ({ method: 'PATCH', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('plugin routes', () => {
  it('lists discovered plugins with enabled flags (admin)', async () => {
    const { app, config, adminTok } = setup();
    // Isolate from the fresh-install default plugin set (files/skills among them) — this test is about
    // the toggle mechanics against the fixture plugins, not which plugins ship enabled out of the box.
    config.update({ plugins: { enabled: [], removed: [] } });
    const res = await app.request('/plugins', auth(adminTok));
    expect(res.status).toBe(200);
    const list = await res.json() as { name: string; enabled: boolean; configurable: boolean; provides: { tools?: string[] } }[];
    expect(list.map((p) => p.name).sort()).toEqual(['discord', 'files', 'risky', 'skills']);
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
    expect(body.configSchema.map((f) => f.key)).toEqual(['botToken', 'guildId', 'historyLimit', 'rolePolicies']);
    expect(body.config.guildId).toBe('g1');
    expect(body.config.botToken).toBeUndefined();
    expect(body.secretsSet).toEqual(['botToken']);
    expect(JSON.stringify(body)).not.toContain('tok-123');
  });

  it('GET /plugins/:name pre-fills an unset field from its declared default, and a stored value wins', async () => {
    const { app, adminTok } = setup();
    // Nothing stored yet → the form should arrive pre-filled with the field's `default`.
    let body = await (await app.request('/plugins/discord', auth(adminTok))).json() as { config: Record<string, unknown> };
    expect(body.config.historyLimit).toBe(25);
    expect(body.config.guildId).toBeUndefined(); // no default declared → still absent
    // Once the user stores a value, it takes precedence over the default (even 0, which is meaningful here).
    await app.request('/plugins/discord/config', patch(adminTok, { values: { historyLimit: 0 } }));
    body = await (await app.request('/plugins/discord', auth(adminTok))).json() as { config: Record<string, unknown> };
    expect(body.config.historyLimit).toBe(0);
  });

  it('PATCH config keeps a stored secret when the field arrives empty', async () => {
    const { app, config, adminTok } = setup();
    await app.request('/plugins/discord/config', patch(adminTok, { values: { botToken: 'tok-123' } }));
    await app.request('/plugins/discord/config', patch(adminTok, { values: { botToken: '', guildId: 'g2' } }));
    expect(config.pluginConfig('discord')).toMatchObject({ botToken: 'tok-123', guildId: 'g2' });
  });

  it('PATCH config treats null as an explicit clear for non-secret overrides', async () => {
    const { app, config, adminTok } = setup();
    await app.request('/plugins/discord/config', patch(adminTok, { values: { historyLimit: 10, botToken: 'tok-123' } }));
    await app.request('/plugins/discord/config', patch(adminTok, { values: { historyLimit: null, botToken: null } }));
    expect(config.pluginConfig('discord').historyLimit).toBeUndefined();
    expect(config.pluginConfig('discord').botToken).toBe('tok-123');
  });

  it('PATCH toggles a plugin, persists config, and hot-reloads the brain', async () => {
    const { app, config, reloadPlugins, adminTok } = setup();
    // Same isolation as above: start from a known-empty enabled set rather than the fresh-install default.
    config.update({ plugins: { enabled: [], removed: [] } });
    const on = await app.request('/plugins/skills', patch(adminTok, { enabled: true }));
    expect(on.status).toBe(200);
    expect((await on.json() as { enabled: boolean }).enabled).toBe(true);
    expect(config.get().plugins.enabled).toEqual(['skills']);
    expect(reloadPlugins).toHaveBeenCalledTimes(1);
    const off = await app.request('/plugins/skills', patch(adminTok, { enabled: false }));
    expect((await off.json() as { enabled: boolean }).enabled).toBe(false);
    expect(config.get().plugins.enabled).toEqual([]);
  });

  it('refuses to enable a plugin claiming powers the caller did not acknowledge', async () => {
    // Enabling is the moment a declared capability becomes real. The red badge in Settings is not
    // consent — nothing makes a reader look at it, and a marketplace install never renders it — so the
    // refusal lives in the API, where curl and a one-click install meet the same answer.
    const { app, config, reloadPlugins, adminTok } = setup();
    config.update({ plugins: { enabled: [], removed: [] } });

    const bare = await app.request('/plugins/risky', patch(adminTok, { enabled: true }));
    expect(bare.status).toBe(409);
    // The answer names what it wants, or the caller is left guessing at a list it cannot see.
    expect(await bare.json()).toEqual({ error: 'grants require consent', grants: ['memory', 'workflow-dag'] });
    expect(config.get().plugins.enabled).toEqual([]);
    expect(reloadPlugins).not.toHaveBeenCalled();

    // Half a consent is no consent: acknowledging one power must not smuggle the other past.
    const partial = await app.request('/plugins/risky', patch(adminTok, { enabled: true, acknowledgeGrants: ['memory'] }));
    expect(partial.status).toBe(409);
    expect(config.get().plugins.enabled).toEqual([]);

    const full = await app.request('/plugins/risky', patch(adminTok, { enabled: true, acknowledgeGrants: ['memory', 'workflow-dag'] }));
    expect(full.status).toBe(200);
    expect(config.get().plugins.enabled).toEqual(['risky']);
  });

  it('asks for no consent to take powers away, nor for a plugin that only shapes a live turn', async () => {
    const { app, config, adminTok } = setup();
    config.update({ plugins: { enabled: ['risky'], removed: [] } });

    // Disabling only ever removes reach.
    expect((await app.request('/plugins/risky', patch(adminTok, { enabled: false }))).status).toBe(200);
    // `prompt`/`turnContext` leave nothing behind after the turn — the reach any chat message has — so
    // gating them would train the operator to click through a dialog that never means anything.
    expect((await app.request('/plugins/skills', patch(adminTok, { enabled: true }))).status).toBe(200);
    expect(config.get().plugins.enabled).toEqual(['skills']);
  });

  it('answers 202 pending — not an error — when the live swap has to wait for running work', async () => {
    const { app, config, reloadPlugins, adminTok } = setup();
    config.update({ plugins: { enabled: [], removed: [] } });
    reloadPlugins.mockResolvedValueOnce(false);

    const res = await app.request('/plugins/skills', patch(adminTok, { enabled: true }));

    // The config write happens BEFORE the swap attempt, so reporting failure here would tell the operator
    // nothing changed while the toggle was already on disk — and the runtime converges on it anyway.
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ enabled: true, pending: true });
    expect(config.get().plugins.enabled).toEqual(['skills']);
  });

  it('reports a deferred config save the same way', async () => {
    const { app, config, reloadPlugins, adminTok } = setup();
    reloadPlugins.mockResolvedValueOnce(false);

    const res = await app.request('/plugins/discord/config', patch(adminTok, { values: { botToken: 'tok-9' } }));

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ok: true, pending: true });
    expect(config.pluginConfig('discord').botToken).toBe('tok-9');
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

  it('GET /plugins/:name surfaces declared capabilities ({} when the manifest omits them)', async () => {
    const root = tmpDir('plugcaps');
    makePlugin(root, 'enricher', { capabilities: { hooks: ['brain.turn.contextBuilt'], mutates: ['turnContext'], network: true } });
    makePlugin(root, 'plain');
    const db = openPluginTablesDb(':memory:');
    const users = new UserStore(db);
    const admin = users.create('admin', 'pw');
    const app = createServer({
      bus: new EventBus(),
      engine: null as never, spawn: null as never, tmux: null as never,
      project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
      clock: new FakeClock(0), config: new ConfigStore(db), users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
      pluginDirs: [root], brainOauth: new BrainOAuthManager(sharedRuntime, noCreds),
    });
    const tok = users.issueToken(admin.id);
    const enriched = await (await app.request('/plugins/enricher', auth(tok))).json() as { capabilities: Record<string, unknown> };
    expect(enriched.capabilities).toEqual({ hooks: ['brain.turn.contextBuilt'], mutates: ['turnContext'], network: true });
    const plain = await (await app.request('/plugins/plain', auth(tok))).json() as { capabilities: Record<string, unknown> };
    expect(plain.capabilities).toEqual({});
  });

  it('GET /plugins/:name includes a data summary', async () => {
    const { app, adminTok } = setup();
    const body = await (await app.request('/plugins/discord', auth(adminTok))).json() as { data: { exists: boolean; files: number; bytes: number } };
    expect(body.data).toEqual({ path: expect.any(String), exists: false, files: 0, bytes: 0 });
  });

  it('does not expose the removed legacy MCP management endpoints', async () => {
    const { app, adminTok } = setup();
    expect((await app.request('/plugins/mcp/servers', auth(adminTok))).status).toBe(404);
    expect((await app.request('/plugins/mcp/servers/mock/reconnect', { method: 'POST', ...auth(adminTok) })).status).toBe(404);
    expect((await app.request('/plugins/mcp/reconnect', { method: 'POST', ...auth(adminTok) })).status).toBe(404);
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

  it('GET /plugins/:name/hook-executions — admin 200 empty, non-admin 403, unknown 404', async () => {
    const { app, adminTok, amyTok } = setup();
    const ok = await app.request('/plugins/discord/hook-executions', auth(adminTok));
    expect(ok.status).toBe(200);
    // No hook-audit buffer wired in this test → empty entries (never a 500).
    expect(await ok.json()).toEqual({ entries: [] });
    expect((await app.request('/plugins/discord/hook-executions', auth(amyTok))).status).toBe(403);
    expect((await app.request('/plugins/ghost/hook-executions', auth(adminTok))).status).toBe(404);
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

describe('notification destination routes', () => {
  async function destinationSetup() {
    const root = tmpDir('destinations');
    const dir = join(root, 'teams');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'elowen-plugin.json'), JSON.stringify({
      name: 'teams', version: '1.0.0', apiVersion: '1', description: 'x', entry: 'index.mjs',
      provides: { destinations: ['msteams'] },
    }));
    writeFileSync(join(dir, 'index.mjs'), `export function register(ctx) {
      ctx.registerNotificationDestinationProvider({ platform: 'msteams', list: () => [
        { id: 'a:filip', kind: 'person', label: 'Filip', group: 'Microsoft Teams' },
      ] });
      ctx.registerTool({
        name: 'teams_tool', label: 'Teams tool', description: 'A test tool.',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
      });
    }`);
    const db = openPluginTablesDb(':memory:');
    const users = new UserStore(db);
    const admin = users.create('admin', 'pw');
    const amy = users.create('amy', 'pw');
    const provider = new PluginRegistryProvider(() => loadPlugins({
      dirs: [root], enabled: ['teams'], logger: { info() {}, warn() {}, error() {} },
    }));
    const app = createServer({
      bus: new EventBus(),
      engine: null as never, spawn: null as never, tmux: null as never,
      project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
      clock: new FakeClock(0), config: new ConfigStore(db), users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
      pluginDirs: [root], pluginDataRoot: tmpDir('destination-data'), plugins: provider,
      brainOauth: new BrainOAuthManager(sharedRuntime, noCreds),
    });
    return { app, adminTok: users.issueToken(admin.id), amyTok: users.issueToken(amy.id) };
  }

  it('serves normalized opaque targets to admins and refuses non-admins', async () => {
    const { app, adminTok, amyTok } = await destinationSetup();
    expect((await app.request('/plugins/destinations', auth(amyTok))).status).toBe(403);
    const response = await app.request('/plugins/destinations', auth(adminTok));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{
      value: 'destination:msteams:a%3Afilip', id: 'a:filip', platform: 'msteams', kind: 'person', label: 'Filip', group: 'Microsoft Teams',
    }]);
  });

  it('serves the live tool catalog to admins and refuses non-admins', async () => {
    const { app, adminTok, amyTok } = await destinationSetup();
    expect((await app.request('/plugins/tools', auth(amyTok))).status).toBe(403);
    const response = await app.request('/plugins/tools', auth(adminTok));
    expect(response.status).toBe(200);
    const tools = await response.json() as { name: string; label: string; plugin: string | null; group: string }[];
    expect(tools).toContainEqual(expect.objectContaining({ name: 'teams_tool', label: 'Teams tool', plugin: 'teams', group: 'plugin' }));
    expect(tools).toContainEqual(expect.objectContaining({ name: 'MemorySearch', plugin: null, group: 'memory' }));
  });

  it('does not expose destination metadata through unauthenticated first-run setup access', async () => {
    const db = openPluginTablesDb(':memory:');
    const users = new UserStore(db);
    const app = createServer({
      bus: new EventBus(),
      engine: null as never, spawn: null as never, tmux: null as never,
      project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
      clock: new FakeClock(0), config: new ConfigStore(db), users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
      pluginDirs: [], pluginDataRoot: tmpDir('destination-setup-data'),
      brainOauth: new BrainOAuthManager(sharedRuntime, noCreds),
    });
    expect((await app.request('/plugins/destinations')).status).toBe(403);
    expect((await app.request('/plugins/tools')).status).toBe(403);
  });
});

describe('sub-agent (typed .md) routes', () => {
  // The '/plugins/agents/*' editor surface is served by the REAL subagent plugin (root mounts) over the
  // core subagentCatalog host seam — wire the seam the way brainCore does, against an isolated user dir.
  function agentSetup(opts: { enabled?: string[] } = {}) {
    const cfgDir = tmpDir('agentcfg');
    const pluginDataRoot = join(cfgDir, 'plugins-data');
    mkdirSync(pluginDataRoot, { recursive: true });
    const userAgentsDir = join(cfgDir, 'agents');
    const db = openPluginTablesDb(':memory:');
    const users = new UserStore(db);
    const admin = users.create('admin', 'pw');
    const amy = users.create('amy', 'pw');
    const pluginsDir = join(process.cwd(), 'plugins');
    const provider = new PluginRegistryProvider(() => loadPlugins({
      dirs: [pluginsDir], enabled: opts.enabled ?? ['subagent'], dataRoot: pluginDataRoot,
      host: {
        subagentCatalog: makeSubagentCatalog({
          builtinDir: promptsPath('agents'), userDir: userAgentsDir,
          pluginToolNames: async () => [],
        }),
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    }));
    const app = createServer({
      bus: new EventBus(),
      engine: null as never, spawn: null as never, tmux: null as never,
      project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
      clock: new FakeClock(0), config: new ConfigStore(db), users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
      pluginDirs: [pluginsDir], pluginDataRoot,
      plugins: provider,
      brain: { reloadPlugins: vi.fn(async () => {}) } as never,
      brainOauth: new BrainOAuthManager(sharedRuntime, noCreds),
    });
    return { app, userAgentsDir, adminTok: users.issueToken(admin.id), amyTok: users.issueToken(amy.id) };
  }
  const put = (t: string, body: unknown) => ({ method: 'PUT', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const del = (t: string) => ({ method: 'DELETE', headers: { authorization: `Bearer ${t}` } });
  const valid = { description: 'Read-only explorer', tools: 'read-only', body: 'You explore.' };

  it('rejects a non-admin (403) on list, create and delete — these write agent-definition files', async () => {
    const { app, amyTok, userAgentsDir } = agentSetup();
    expect((await app.request('/plugins/agents/list', auth(amyTok))).status).toBe(403);
    expect((await app.request('/plugins/agents/mine', put(amyTok, valid))).status).toBe(403);
    expect((await app.request('/plugins/agents/mine', del(amyTok))).status).toBe(403);
    expect(existsSync(userAgentsDir)).toBe(false); // nothing was written
  });

  it('refuses a non-kebab / path-traversal name (400) and writes nothing to disk', async () => {
    const { app, adminTok, userAgentsDir } = agentSetup();
    // %2F decodes to a slash in the :name param; the kebab guard must refuse it before any writeFileSync.
    expect((await app.request('/plugins/agents/..%2Fescape', put(adminTok, valid))).status).toBe(400);
    expect((await app.request('/plugins/agents/UPPER', put(adminTok, valid))).status).toBe(400);
    expect((await app.request('/plugins/agents/has.dot', put(adminTok, valid))).status).toBe(400);
    expect((await app.request('/plugins/agents/..%2Fescape', del(adminTok))).status).toBe(400);
    expect(existsSync(userAgentsDir)).toBe(false);
  });

  it('refuses to shadow or delete a built-in agent (400) so a read-only type cannot be overridden', async () => {
    const { app, adminTok, userAgentsDir } = agentSetup();
    // explore/plan ship built-in and read-only; loadAgentRegistry loads the user dir LAST, so a user file
    // of the same name would win — the guard must block it, or a read-only type becomes writable.
    expect((await app.request('/plugins/agents/explore', put(adminTok, { ...valid, tools: 'all' }))).status).toBe(400);
    expect((await app.request('/plugins/agents/plan', del(adminTok))).status).toBe(400);
    expect(existsSync(join(userAgentsDir, 'explore.md'))).toBe(false);
  });

  it('rejects an invalid tools spec before writing (400), leaving the agents dir empty', async () => {
    const { app, adminTok, userAgentsDir } = agentSetup();
    expect((await app.request('/plugins/agents/mine', put(adminTok, { ...valid, tools: 'bogus' }))).status).toBe(400);
    expect((await app.request('/plugins/agents/mine', put(adminTok, { ...valid, tools: [] }))).status).toBe(400);
    expect((await app.request('/plugins/agents/mine', put(adminTok, { description: '', tools: 'all', body: 'x' }))).status).toBe(400);
    expect(existsSync(userAgentsDir) && readdirSync(userAgentsDir).length > 0).toBe(false);
  });

  it('creates a user agent, round-trips a colon/hash description through YAML, then deletes it', async () => {
    const { app, adminTok, userAgentsDir } = agentSetup();
    // A description with ': ' and a leading '#' is exactly what string-interpolated frontmatter would
    // mangle into invalid YAML; the YAML-library serialization must let it round-trip through the parser.
    const description = 'Use when: triaging #42 regressions';
    const created = await app.request('/plugins/agents/triage', put(adminTok, { description, tools: 'read-only', body: 'Investigate.' }));
    expect(created.status).toBe(201);
    expect(existsSync(join(userAgentsDir, 'triage.md'))).toBe(true);
    const list = await (await app.request('/plugins/agents/list', auth(adminTok))).json() as { name: string; description: string; source: string; canDelete: boolean }[];
    const mine = list.find((a) => a.name === 'triage');
    expect(mine).toMatchObject({ description, source: 'user', canDelete: true });
    // Built-ins are present and marked read-only.
    expect(list.find((a) => a.name === 'explore')).toMatchObject({ source: 'builtin', canDelete: false });
    const removed = await app.request('/plugins/agents/triage', del(adminTok));
    expect(removed.status).toBe(200);
    expect(existsSync(join(userAgentsDir, 'triage.md'))).toBe(false);
  });

  it('answers 503 "subagent plugin is disabled" when the plugin is off', async () => {
    const { app, adminTok } = agentSetup({ enabled: [] });
    const res = await app.request('/plugins/agents/list', auth(adminTok));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'subagent plugin is disabled' });
    expect((await app.request('/plugins/agents/mine', put(adminTok, valid))).status).toBe(503);
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
    // Exhaustive on purpose: the map is derived from OAUTH_BUILTIN, so a new account type has to show up
    // here, and a type that silently fails to reach the routes shows up as a missing key.
    expect(await res.json()).toEqual({
      'oauth-anthropic': false, 'oauth-github-copilot': false, 'oauth-openai-codex': false, 'oauth-kimi': false,
    });
  });

  it('start rejects an unknown type (404)', async () => {
    const { app, adminTok } = oauthSetup();
    expect((await app.request('/brain/oauth/bogus/start', { method: 'POST', headers: { authorization: `Bearer ${adminTok}` } })).status).toBe(404);
  });
});
