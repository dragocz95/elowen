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

let dirs: string[] = [];
const tmpDir = (tag: string): string => { const p = mkdtempSync(join(tmpdir(), `elowen-${tag}-`)); dirs.push(p); return p; };
afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });

/** A plugin that keeps per-ACCOUNT credentials: one secret, one plain field, and a route that echoes back
 *  whatever `ctx.userConfig()` resolves for whoever is calling. It declares NO `reads` capability — reading
 *  its own per-account slice must not require the database grant. */
function crmPluginDir(opts: { userGrantable?: boolean; userConfigLabel?: string; i18n?: Record<string, unknown> } = {}): string {
  const root = tmpDir('usercfg-plugins');
  const dir = join(root, 'crmdemo');
  mkdirSync(dir, { recursive: true });
  if (opts.i18n) {
    mkdirSync(join(dir, 'i18n'), { recursive: true });
    for (const [lang, body] of Object.entries(opts.i18n)) writeFileSync(join(dir, 'i18n', `${lang}.json`), JSON.stringify(body));
  }
  writeFileSync(join(dir, 'elowen-plugin.json'), JSON.stringify({
    name: 'crmdemo', version: '1.0.0', apiVersion: '1', description: 'crm demo', entry: 'index.mjs',
    ...(opts.userGrantable ? { userGrantable: true } : {}),
    ...(opts.userConfigLabel ? { userConfigLabel: opts.userConfigLabel } : {}),
    provides: { apiRoutes: ['/crmdemo'] },
    userConfigSchema: [
      { key: 'apiKey', label: 'API key', type: 'secret' },
      { key: 'region', label: 'Region', type: 'string', default: 'eu' },
      { key: 'timezone', label: 'Timezone', type: 'timezone' },
      { key: 'paths', label: 'Paths', type: 'tokenList' },
      { key: 'seats', label: 'Seats', type: 'number', min: 1, max: 10, step: 1, default: 3 },
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

function setup(opts: { userGrantable?: boolean; userConfigLabel?: string; i18n?: Record<string, unknown> } = {}) {
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
    bus: new EventBus(),
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
type View = { name: string; config: Record<string, unknown>; secretsSet: string[]; revision: number };

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

  it('rejects a stale user-config snapshot and preserves the newer value', async () => {
    const { app, amyTok } = setup();
    expect((await (await app.request('/plugins/user-config', auth(amyTok))).json() as View[])[0]!.revision).toBe(0);
    expect((await app.request('/plugins/crmdemo/user-config', patch(amyTok, { values: { region: 'cz' }, expectedRevision: 0 }))).status).toBe(200);
    const stale = await app.request('/plugins/crmdemo/user-config', patch(amyTok, { values: { region: 'sk' }, expectedRevision: 0 }));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'conflict', current: { config: { region: 'cz' }, revision: 1 } });
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

  it('keeps an unchanged legacy-invalid number in a full snapshot while saving another user field', async () => {
    const { app, userPluginConfig, amy, amyTok } = setup();
    userPluginConfig.set(amy.id, 'crmdemo', { apiKey: 'legacy-key', region: 'old', seats: 4.5 });
    const listing = await (await app.request('/plugins/user-config', auth(amyTok))).json() as View[];
    expect(listing[0]!.config.seats).toBe(4.5);

    const saved = await app.request('/plugins/crmdemo/user-config', patch(amyTok, {
      values: { ...listing[0]!.config, apiKey: '', region: 'new' },
    }));
    expect(saved.status).toBe(200);
    expect(userPluginConfig.get(amy.id, 'crmdemo')).toEqual({ apiKey: 'legacy-key', region: 'new', seats: 4.5 });

    const changedInvalid = await app.request('/plugins/crmdemo/user-config', patch(amyTok, {
      values: { ...listing[0]!.config, region: 'must-not-land', seats: 5.5 },
    }));
    expect(changedInvalid.status).toBe(400);
    expect(await changedInvalid.json()).toEqual({ error: 'invalid value for "seats": must align to step 1 from 1' });
    expect(userPluginConfig.get(amy.id, 'crmdemo')).toEqual({ apiKey: 'legacy-key', region: 'new', seats: 4.5 });
  });

  it('validates changed user token lists atomically while allowing an unchanged legacy string', async () => {
    const { app, userPluginConfig, amy, amyTok } = setup();
    userPluginConfig.set(amy.id, 'crmdemo', { region: 'old', paths: '/legacy,path' });
    const listing = await (await app.request('/plugins/user-config', auth(amyTok))).json() as View[];

    const unrelated = await app.request('/plugins/crmdemo/user-config', patch(amyTok, {
      values: { ...listing[0]!.config, region: 'new' },
    }));
    expect(unrelated.status).toBe(200);
    expect(userPluginConfig.get(amy.id, 'crmdemo')).toMatchObject({ region: 'new', paths: '/legacy,path' });

    for (const invalid of ['/changed', ['/ok', {}], { path: '/object' }, 7, [''], [' /space'], ['/dup', '/dup']]) {
      const rejected = await app.request('/plugins/crmdemo/user-config', patch(amyTok, {
        values: { ...listing[0]!.config, region: 'must-not-land', paths: invalid },
      }));
      expect(rejected.status, JSON.stringify(invalid)).toBe(400);
      expect(userPluginConfig.get(amy.id, 'crmdemo')).toMatchObject({ region: 'new', paths: '/legacy,path' });
    }

    const valid = await app.request('/plugins/crmdemo/user-config', patch(amyTok, { values: { paths: ['/one', '/two,three'] } }));
    expect(valid.status).toBe(200);
    expect(userPluginConfig.get(amy.id, 'crmdemo').paths).toEqual(['/one', '/two,three']);
  });

  it('validates changed user timezones while preserving an unchanged invalid legacy value', async () => {
    const { app, userPluginConfig, amy, amyTok } = setup();
    userPluginConfig.set(amy.id, 'crmdemo', { region: 'old', timezone: 'Mars/Olympus' });
    const listing = await (await app.request('/plugins/user-config', auth(amyTok))).json() as View[];

    const unrelated = await app.request('/plugins/crmdemo/user-config', patch(amyTok, {
      values: { ...listing[0]!.config, region: 'new' },
    }));
    expect(unrelated.status).toBe(200);
    expect(userPluginConfig.get(amy.id, 'crmdemo')).toMatchObject({ region: 'new', timezone: 'Mars/Olympus' });

    const changedInvalid = await app.request('/plugins/crmdemo/user-config', patch(amyTok, {
      values: { ...listing[0]!.config, region: 'must-not-land', timezone: 'Mars/Valles' },
    }));
    expect(changedInvalid.status).toBe(400);
    expect(userPluginConfig.get(amy.id, 'crmdemo')).toMatchObject({ region: 'new', timezone: 'Mars/Olympus' });
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

  // The Account rail shows a NAME and the panel a sentence, so the listing has to carry them as two
  // separate strings. It used to send only `description`, the UI titled the rail entry with it, and a
  // plugin whose description is a full sentence took the rail over.
  it('carries the short per-account label beside the description, never folded into it', async () => {
    const { app, amyTok } = setup({ userConfigLabel: 'CRM Demo' });
    const listing = await (await app.request('/plugins/user-config', auth(amyTok))).json() as { name: string; label?: string; description?: string }[];
    expect(listing[0]).toMatchObject({ name: 'crmdemo', label: 'CRM Demo', description: 'crm demo' });
  });

  // A plugin that declares no label must fall back to something short. The description is never it.
  it('omits the label for a plugin that declares none, leaving the client its own short fallback', async () => {
    const { app, amyTok } = setup();
    const listing = await (await app.request('/plugins/user-config', auth(amyTok))).json() as { label?: string; description?: string }[];
    expect(listing[0]!.label).toBeUndefined();
    expect(listing[0]!.description).toBe('crm demo');
  });

  // Localization travels through the plugin's own i18n files — the same machinery every other manifest
  // string uses — so a Czech account gets a Czech menu entry without the host learning any plugin names.
  it('serves the plugin\'s localized label and description through its own i18n files', async () => {
    const { app, amyTok } = setup({
      userConfigLabel: 'CRM Demo',
      i18n: { cs: { userConfigLabel: 'CRM demo', description: 'Osobní přístup k CRM demo.' } },
    });
    const listing = await (await app.request('/plugins/user-config', auth(amyTok))).json() as {
      label?: string; description?: string; i18n?: Record<string, { userConfigLabel?: string; description?: string }>;
    }[];
    expect(listing[0]!.i18n?.cs).toMatchObject({ userConfigLabel: 'CRM demo', description: 'Osobní přístup k CRM demo.' });
    // English stays on the record itself as the fallback for a locale the plugin does not translate.
    expect(listing[0]).toMatchObject({ label: 'CRM Demo', description: 'crm demo' });
  });

  it('answers nothing for a plugin that declares no per-account fields', async () => {
    const { app, amyTok } = setup();
    expect((await app.request('/plugins/skills/user-config', patch(amyTok, { values: { region: 'cz' } }))).status).toBe(404);
  });
});
