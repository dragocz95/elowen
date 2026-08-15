import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { UserPluginConfigStore } from '../../src/store/userPluginConfigStore.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';
import { loadPlugins } from '../../src/plugins/loader.js';
import { PluginRegistryProvider } from '../../src/plugins/pluginsProvider.js';
import { RefMissions, RefReadiness, RefTaskStore } from '../helpers/refStores.js';

let dirs: string[] = [];
const tmpDir = (tag: string): string => { const p = mkdtempSync(join(tmpdir(), `elowen-${tag}-`)); dirs.push(p); return p; };
afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });

/** A plugin that keeps per-ACCOUNT credentials: one secret, one plain field, and a route that echoes back
 *  whatever `ctx.userConfig()` resolves for whoever is calling. It declares NO `reads` capability — reading
 *  its own per-account slice must not require the database grant. */
function crmPluginDir(opts: { userGrantable?: boolean } = {}): string {
  const root = tmpDir('usercfg-plugins');
  const dir = join(root, 'crmdemo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'elowen-plugin.json'), JSON.stringify({
    name: 'crmdemo', version: '1.0.0', apiVersion: '1', description: 'crm demo', entry: 'index.mjs',
    ...(opts.userGrantable ? { userGrantable: true } : {}),
    provides: { apiRoutes: ['/crmdemo'] },
    userConfigSchema: [
      { key: 'apiKey', label: 'API key', type: 'secret' },
      { key: 'region', label: 'Region', type: 'string', default: 'eu' },
    ],
  }));
  writeFileSync(join(dir, 'index.mjs'), `
export function register(ctx) {
  ctx.registerApiRoute({ rootMount: '/crmdemo', path: '', method: 'GET', access: 'user', handler: async () => ({
    body: { seen: ctx.userConfig() },
  }) });
}
`);
  return root;
}

function setup(opts: { userGrantable?: boolean } = {}) {
  const pluginsDir = crmPluginDir(opts);
  const dataRoot = tmpDir('usercfg-data');
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw');
  const amy = users.create('amy', 'pw');
  const ben = users.create('ben', 'pw');
  const userPluginConfig = new UserPluginConfigStore(db);
  const config = new ConfigStore(db);
  config.update({ plugins: { enabled: ['crmdemo'] } });
  const provider = new PluginRegistryProvider(() => loadPlugins({
    dirs: [pluginsDir], enabled: ['crmdemo'], dataRoot,
    host: { userPluginConfig: (userId, plugin) => userPluginConfig.get(userId, plugin) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }));
  const app = createServer({
    tasks: new RefTaskStore(db), readiness: new RefReadiness(db), missions: new RefMissions(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
    pluginDirs: [pluginsDir], pluginDataRoot: dataRoot, userPluginConfig,
    plugins: provider,
  });
  return {
    app, users, userPluginConfig, admin, amy, ben,
    adminTok: users.issueToken(admin.id), amyTok: users.issueToken(amy.id), benTok: users.issueToken(ben.id),
  };
}

const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const patch = (t: string, body: unknown) => ({ method: 'PATCH', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
type View = { name: string; config: Record<string, unknown>; secretsSet: string[] };

describe('per-user plugin config', () => {
  it('keeps two accounts on their own values, and neither can read the other through the API', async () => {
    const { app, amyTok, benTok } = setup();
    await app.request('/plugins/crmdemo/user-config', patch(amyTok, { values: { apiKey: 'amy-key', region: 'cz' } }));
    await app.request('/plugins/crmdemo/user-config', patch(benTok, { values: { apiKey: 'ben-key', region: 'sk' } }));

    const listFor = async (tok: string) => (await (await app.request('/plugins/user-config', auth(tok))).json()) as View[];
    const amyList = await listFor(amyTok);
    const benList = await listFor(benTok);
    expect(amyList[0]!.config.region).toBe('cz');
    expect(benList[0]!.config.region).toBe('sk');
    // The whole response body, not just the parsed field: a secret must not travel in ANY shape.
    expect(JSON.stringify(amyList)).not.toContain('amy-key');
    expect(JSON.stringify(amyList)).not.toContain('ben-key');
    // "Who has it configured" is fine to know — the value is not.
    expect(amyList[0]!.secretsSet).toEqual(['apiKey']);
  });

  it('shows an admin their OWN values, never another account\'s', async () => {
    const { app, adminTok, amyTok } = setup();
    await app.request('/plugins/crmdemo/user-config', patch(amyTok, { values: { region: 'cz' } }));
    const adminList = (await (await app.request('/plugins/user-config', auth(adminTok))).json()) as View[];
    // The admin never set anything, so they see the declared default — not Amy's value.
    expect(adminList[0]!.config.region).toBe('eu');
  });

  it('hands the plugin the values of whoever is acting, one request after another', async () => {
    const { app, amyTok, benTok } = setup();
    await app.request('/plugins/crmdemo/user-config', patch(amyTok, { values: { apiKey: 'amy-key', region: 'cz' } }));
    await app.request('/plugins/crmdemo/user-config', patch(benTok, { values: { apiKey: 'ben-key', region: 'sk' } }));
    const seenBy = async (tok: string) => ((await (await app.request('/crmdemo', auth(tok))).json()) as { seen: Record<string, unknown> | null }).seen;
    // Same process, same loaded plugin instance: the identity must be resolved per call, not captured.
    expect(await seenBy(amyTok)).toEqual({ apiKey: 'amy-key', region: 'cz' });
    expect(await seenBy(benTok)).toEqual({ apiKey: 'ben-key', region: 'sk' });
    expect(await seenBy(amyTok)).toEqual({ apiKey: 'amy-key', region: 'cz' });
  });

  it('keeps a stored secret when the form saves it back empty, and clears a plain field on null', async () => {
    const { app, amyTok } = setup();
    await app.request('/plugins/crmdemo/user-config', patch(amyTok, { values: { apiKey: 'amy-key', region: 'cz' } }));
    const after = (await (await app.request('/plugins/crmdemo/user-config', patch(amyTok, { values: { apiKey: '', region: null } }))).json()) as View;
    expect(after.secretsSet).toEqual(['apiKey']);
    // Cleared back to unset, so the response shows the declared default again.
    expect(after.config.region).toBe('eu');
    const seen = ((await (await app.request('/crmdemo', auth(amyTok))).json()) as { seen: Record<string, unknown> }).seen;
    expect(seen).toEqual({ apiKey: 'amy-key' });
  });

  it('drops an account\'s values when the account is deleted', async () => {
    const { app, users, userPluginConfig, amy, adminTok, amyTok } = setup();
    await app.request('/plugins/crmdemo/user-config', patch(amyTok, { values: { apiKey: 'amy-key' } }));
    expect(userPluginConfig.get(amy.id, 'crmdemo')).toEqual({ apiKey: 'amy-key' });
    expect((await app.request(`/users/${amy.id}`, { method: 'DELETE', ...auth(adminTok) })).status).toBe(200);
    // Leaving the row behind would keep one person's API key on the operator's disk after they are gone.
    expect(userPluginConfig.get(amy.id, 'crmdemo')).toEqual({});
    expect(users.list().some((u) => u.id === amy.id)).toBe(false);
  });

  it('refuses a plugin the account was never granted, in the listing and by URL', async () => {
    const { app, users, amy, amyTok } = setup({ userGrantable: true });
    expect(await (await app.request('/plugins/user-config', auth(amyTok))).json()).toEqual([]);
    // Hiding the section is worthless if the save endpoint still accepts a hand-made request.
    expect((await app.request('/plugins/crmdemo/user-config', patch(amyTok, { values: { region: 'cz' } }))).status).toBe(404);

    users.setGrantedPlugins(amy.id, ['crmdemo']);
    expect(((await (await app.request('/plugins/user-config', auth(amyTok))).json()) as View[]).map((p) => p.name)).toEqual(['crmdemo']);
    expect((await app.request('/plugins/crmdemo/user-config', patch(amyTok, { values: { region: 'cz' } }))).status).toBe(200);
  });

  it('answers nothing for a plugin that declares no per-account fields', async () => {
    const { app, amyTok } = setup();
    expect((await app.request('/plugins/skills/user-config', patch(amyTok, { values: { region: 'cz' } }))).status).toBe(404);
  });
});
