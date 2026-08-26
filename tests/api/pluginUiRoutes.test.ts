import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestApp } from '../helpers/testApp.js';
import { loadPlugins } from '../../src/plugins/loader.js';
import { PluginRegistryProvider } from '../../src/plugins/pluginsProvider.js';

const BUNDLE = 'window.__elowenRegisterPluginUi("demo",{requiresApiVersion:1,pages:{}});';
const HASH = createHash('sha256').update(BUNDLE).digest('hex').slice(0, 16);
// The plugin's own stylesheet. Elowen ships a PREBUILT web app, so its CSS carries only the utilities
// the host itself uses; anything else a plugin's markup needs arrives on this second asset.
const CSS = '@layer utilities{.w-\\[137px\\]{width:137px}}';
const CSS_HASH = createHash('sha256').update(CSS).digest('hex').slice(0, 16);

let pluginRoots: string[] = [];
afterEach(() => { for (const p of pluginRoots) rmSync(p, { recursive: true, force: true }); pluginRoots = []; });

/** On-disk fixture: `demo` ships a browser UI (bundle + nav/settings + cs overrides); `plain` has none. */
function uiPluginProvider(adminOnly = false): PluginRegistryProvider {
  const root = mkdtempSync(join(tmpdir(), 'plugin-ui-'));
  pluginRoots.push(root);
  for (const name of ['demo', 'plain']) {
    const dir = join(root, name);
    mkdirSync(join(dir, 'i18n'), { recursive: true });
    mkdirSync(join(dir, 'web'), { recursive: true });
    const web = name === 'demo'
      ? {
          web: {
            entry: 'web/index.js',
            css: 'web/index.css',
            adminOnly,
            label: 'Demo',
            nav: [{ label: 'Demo world', icon: 'Bot', route: '' }],
            account: [{ id: 'demo-account', label: 'Demo account', icon: 'Github' }],
            user: [{ id: 'demo-user', label: 'Demo user', icon: 'Server' }],
            project: [{ id: 'demo-project', label: 'Demo project', icon: 'Folder' }],
            settings: [{ id: 'demo-settings', label: 'Demo settings', icon: 'Puzzle' }],
            strings: { greeting: 'Hello', untranslated: 'Stays English' },
          },
        }
      : {};
    writeFileSync(join(dir, 'elowen-plugin.json'), JSON.stringify({
      name, version: '1.0.0', apiVersion: '1', description: name, entry: 'index.mjs', ...web,
    }));
    writeFileSync(join(dir, 'index.mjs'), 'export function register(){}');
    if (name === 'demo') {
      writeFileSync(join(dir, 'web', 'index.js'), BUNDLE);
      writeFileSync(join(dir, 'web', 'index.css'), CSS);
      writeFileSync(join(dir, 'i18n', 'cs.json'), JSON.stringify({
        web: { label: 'Demo česky', nav: { '': 'Demo svět' }, account: { 'demo-account': 'Účet dema' }, user: { 'demo-user': 'Uživatel dema' }, project: { 'demo-project': 'Projekt dema' }, settings: { 'demo-settings': 'Nastavení dema' }, strings: { greeting: 'Ahoj' } },
      }));
    }
  }
  return new PluginRegistryProvider(() => loadPlugins({
    dirs: [root], enabled: ['demo', 'plain'], delegatedTurnsOutOfProcess: false, logger: { info() {}, warn() {}, error() {} },
  }));
}

const makeApp = async (adminOnly = false) => makeTestApp({ extra: { plugins: uiPluginProvider(adminOnly) } });
const auth = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

/** A UI plugin declaring one account panel and one project panel, whose `register()` body is supplied by
 *  the test — the only way to exercise `ctx.registerUiVisibility`, which is a runtime registration rather
 *  than manifest metadata. */
function probePluginProvider(registerBody: string): PluginRegistryProvider {
  const root = mkdtempSync(join(tmpdir(), 'plugin-ui-probe-'));
  pluginRoots.push(root);
  const dir = join(root, 'probe');
  mkdirSync(join(dir, 'web'), { recursive: true });
  writeFileSync(join(dir, 'elowen-plugin.json'), JSON.stringify({
    name: 'probe', version: '1.0.0', apiVersion: '1', description: 'probe', entry: 'index.mjs',
    web: {
      entry: 'web/index.js',
      account: [{ id: 'probe-account', label: 'Probe account' }],
      project: [{ id: 'probe-project', label: 'Probe project' }],
    },
  }));
  writeFileSync(join(dir, 'index.mjs'), `export function register(ctx){${registerBody}}`);
  writeFileSync(join(dir, 'web', 'index.js'), BUNDLE);
  return new PluginRegistryProvider(() => loadPlugins({
    dirs: [root], enabled: ['probe'], delegatedTurnsOutOfProcess: false, logger: { info() {}, warn() {}, error() {} },
  }));
}

type ProbeListing = { name: string; account: { id: string }[]; project: { id: string }[] }[];

describe('plugin browser UI routes', () => {
  it('GET /plugins/ui lists only plugins WITH a bundle, for any authenticated user', async () => {
    const { app, token, deps } = await makeApp();
    expect((await app.request('/plugins/ui')).status).toBe(401);
    const amy = deps.users.create('amy', 'pw');
    const res = await app.request('/plugins/ui', auth(deps.users.issueToken(amy.id)));
    expect(res.status).toBe(200);
    const list = await res.json() as { name: string; url: string; apiVersion: number; nav: { label: string; icon?: string; route?: string }[]; account: { id: string; label: string; icon?: string }[]; user: { id: string; label: string; icon?: string }[]; project: { id: string; label: string; icon?: string }[]; settings: { id: string; label: string }[] }[];
    expect(list.map((p) => p.name)).toEqual(['demo']);
    expect(list[0]!.url).toBe(`/plugins/demo/web/${HASH}.js`);
    expect(list[0]!.apiVersion).toBe(1);
    expect(list[0]!.nav).toEqual([{ label: 'Demo world', icon: 'Bot', route: '' }]);
    expect(list[0]!.account).toEqual([{ id: 'demo-account', label: 'Demo account', icon: 'Github' }]);
    expect(list[0]!.user).toEqual([]);
    expect(list[0]!.project).toEqual([{ id: 'demo-project', label: 'Demo project', icon: 'Folder' }]);
    // Admin receives the selected-User panels; ordinary accounts do not receive their metadata.
    const adminRes = await app.request('/plugins/ui', auth(token));
    const adminList = await adminRes.json() as typeof list;
    expect(adminList).toHaveLength(1);
    expect(adminList[0]!.user).toEqual([{ id: 'demo-user', label: 'Demo user', icon: 'Server' }]);
  });

  it('hides admin-only navigation and assets from non-admin accounts', async () => {
    const { app, token, deps } = await makeApp(true);
    const amy = deps.users.create('amy', 'pw');
    const amyToken = deps.users.issueToken(amy.id);

    const userList = await (await app.request('/plugins/ui', auth(amyToken))).json() as unknown[];
    expect(userList).toEqual([]);
    expect((await app.request(`/plugins/demo/web/${HASH}.js`, auth(amyToken))).status).toBe(403);

    const adminList = await (await app.request('/plugins/ui', auth(token))).json() as unknown[];
    expect(adminList).toHaveLength(1);
    expect((await app.request(`/plugins/demo/web/${HASH}.js`, auth(token))).status).toBe(200);
  });

  it('?lang=cs localizes nav/settings labels and view strings from the plugin i18n web block', async () => {
    const { app, token } = await makeApp();
    const res = await app.request('/plugins/ui?lang=cs', auth(token));
    const list = await res.json() as { label?: string; nav: { label: string }[]; account: { label: string }[]; user: { label: string }[]; project: { label: string }[]; settings: { label: string }[]; strings: Record<string, string> }[];
    // The world's own name localizes like every other menu label — the sidebar groups a multi-page
    // plugin under it, so leaving it English would show one untranslated word in a translated menu.
    expect(list[0]!.label).toBe('Demo česky');
    expect(list[0]!.nav[0]!.label).toBe('Demo svět');
    expect(list[0]!.account[0]!.label).toBe('Účet dema');
    expect(list[0]!.user[0]!.label).toBe('Uživatel dema');
    expect(list[0]!.project[0]!.label).toBe('Projekt dema');
    expect(list[0]!.settings[0]!.label).toBe('Nastavení dema');
    // View strings merge PER KEY: a translated key overrides, an untranslated one keeps English.
    expect(list[0]!.strings).toEqual({ greeting: 'Ahoj', untranslated: 'Stays English' });
    // unknown locale falls back to manifest English
    const en = await app.request('/plugins/ui?lang=de', auth(token));
    const enList = await en.json() as { label?: string; nav: { label: string }[]; strings: Record<string, string> }[];
    expect(enList[0]!.label).toBe('Demo');
    expect(enList[0]!.nav[0]!.label).toBe('Demo world');
    expect(enList[0]!.strings).toEqual({ greeting: 'Hello', untranslated: 'Stays English' });
  });

  it('lets a plugin hide its own panels per account, leaving an unnamed surface untouched', async () => {
    // The probe returns null for an admin (no opinion → everything visible) and hides only the PROJECT
    // surface for anyone else. The account surface is never named, which must mean "leave it alone"
    // rather than "hide it" — otherwise every plugin filtering one surface would silently lose the other.
    const { app, token, deps } = await makeTestApp({ extra: { plugins: probePluginProvider(
      'ctx.registerUiVisibility((req) => (req.isAdmin ? null : { project: [] }));',
    ) } });
    const amy = deps.users.create('amy', 'pw');

    const mine = await (await app.request('/plugins/ui', auth(token))).json() as ProbeListing;
    expect(mine[0]!.project.map((p) => p.id)).toEqual(['probe-project']);
    expect(mine[0]!.account.map((p) => p.id)).toEqual(['probe-account']);

    const hers = await (await app.request('/plugins/ui', auth(deps.users.issueToken(amy.id)))).json() as ProbeListing;
    // The plugin itself is still hers — only the panel is gone, and its id never reached the browser.
    expect(hers.map((p) => p.name)).toEqual(['probe']);
    expect(hers[0]!.project).toEqual([]);
    expect(hers[0]!.account.map((p) => p.id)).toEqual(['probe-account']);
  });

  it('hides the panels of a plugin whose visibility probe throws, without breaking the listing', async () => {
    // One plugin answering badly must not empty everybody's menu, and a panel whose owner just failed is
    // the wrong thing to show: fail closed for that plugin, keep serving everyone else.
    const { app, token } = await makeTestApp({ extra: { plugins: probePluginProvider(
      "ctx.registerUiVisibility(() => { throw new Error('probe exploded'); });",
    ) } });
    const res = await app.request('/plugins/ui', auth(token));
    expect(res.status).toBe(200);
    const list = await res.json() as ProbeListing;
    expect(list.map((p) => p.name)).toEqual(['probe']);
    expect(list[0]!.project).toEqual([]);
    expect(list[0]!.account).toEqual([]);
  });

  it('serves the bundle immutably on the content-hash URL and 404s a stale hash', async () => {
    const { app, token } = await makeApp();
    const res = await app.request(`/plugins/demo/web/${HASH}.js`, auth(token));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(BUNDLE);
    expect(res.headers.get('content-type')).toContain('text/javascript');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect((await app.request('/plugins/demo/web/deadbeef00000000.js', auth(token))).status).toBe(404);
    expect((await app.request(`/plugins/plain/web/${HASH}.js`, auth(token))).status).toBe(404);
    expect((await app.request(`/plugins/demo/web/${HASH}.js`)).status).toBe(401);
  });

  it('advertises the plugin stylesheet in the listing, and only for a plugin that ships one', async () => {
    const { app, token } = await makeApp();
    const list = await (await app.request('/plugins/ui', auth(token))).json() as { name: string; cssUrl?: string }[];
    expect(list.find((p) => p.name === 'demo')!.cssUrl).toBe(`/plugins/demo/web/${CSS_HASH}.css`);
  });

  it('leaves cssUrl absent for a UI plugin with no stylesheet — the old, unstyled behaviour', async () => {
    // The whole point of shipping this ahead of the registry: an existing plugin must keep working
    // exactly as today. No key at all, so nothing downstream can build a URL out of `undefined`.
    const root = mkdtempSync(join(tmpdir(), 'plugin-ui-nocss-'));
    pluginRoots.push(root);
    const dir = join(root, 'bare');
    mkdirSync(join(dir, 'web'), { recursive: true });
    writeFileSync(join(dir, 'elowen-plugin.json'), JSON.stringify({
      name: 'bare', version: '1.0.0', apiVersion: '1', description: 'bare', entry: 'index.mjs',
      web: { entry: 'web/index.js', nav: [{ label: 'Bare', route: '' }] },
    }));
    writeFileSync(join(dir, 'index.mjs'), 'export function register(){}');
    writeFileSync(join(dir, 'web', 'index.js'), BUNDLE);
    const { app, token } = await makeTestApp({ extra: { plugins: new PluginRegistryProvider(() => loadPlugins({
      dirs: [root], enabled: ['bare'], delegatedTurnsOutOfProcess: false, logger: { info() {}, warn() {}, error() {} },
    })) } });
    const list = await (await app.request('/plugins/ui', auth(token))).json() as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect('cssUrl' in list[0]!).toBe(false);
  });

  it('serves the stylesheet as text/css on its OWN content-hash URL and 404s a stale one', async () => {
    const { app, token } = await makeApp();
    const res = await app.request(`/plugins/demo/web/${CSS_HASH}.css`, auth(token));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(CSS);
    // A wrong MIME type is not cosmetic: a browser refuses to APPLY a stylesheet served as anything else.
    expect(res.headers.get('content-type')).toContain('text/css');
    expect(res.headers.get('cache-control')).toContain('immutable');
    // The stylesheet hash is its own — the bundle's must not open this door, or a reload that changed
    // only the CSS would keep serving the previous generation from cache.
    expect((await app.request(`/plugins/demo/web/${HASH}.css`, auth(token))).status).toBe(404);
    expect((await app.request(`/plugins/demo/web/${CSS_HASH}.js`, auth(token))).status).toBe(404);
    expect((await app.request('/plugins/demo/web/deadbeef00000000.css', auth(token))).status).toBe(404);
    expect((await app.request(`/plugins/plain/web/${CSS_HASH}.css`, auth(token))).status).toBe(404);
    expect((await app.request(`/plugins/demo/web/${CSS_HASH}.css`)).status).toBe(401);
  });
});
