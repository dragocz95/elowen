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

let pluginRoots: string[] = [];
afterEach(() => { for (const p of pluginRoots) rmSync(p, { recursive: true, force: true }); pluginRoots = []; });

/** On-disk fixture: `demo` ships a browser UI (bundle + nav/settings + cs overrides); `plain` has none. */
function uiPluginProvider(): PluginRegistryProvider {
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
            label: 'Demo',
            nav: [{ label: 'Demo world', icon: 'Bot', route: '' }],
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
      writeFileSync(join(dir, 'i18n', 'cs.json'), JSON.stringify({
        web: { label: 'Demo česky', nav: { '': 'Demo svět' }, settings: { 'demo-settings': 'Nastavení dema' }, strings: { greeting: 'Ahoj' } },
      }));
    }
  }
  return new PluginRegistryProvider(() => loadPlugins({
    dirs: [root], enabled: ['demo', 'plain'], logger: { info() {}, warn() {}, error() {} },
  }));
}

const makeApp = async () => makeTestApp({ extra: { plugins: uiPluginProvider() } });
const auth = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

describe('plugin browser UI routes', () => {
  it('GET /plugins/ui lists only plugins WITH a bundle, for any authenticated user', async () => {
    const { app, token, deps } = await makeApp();
    expect((await app.request('/plugins/ui')).status).toBe(401);
    const amy = deps.users.create('amy', 'pw');
    const res = await app.request('/plugins/ui', auth(deps.users.issueToken(amy.id)));
    expect(res.status).toBe(200);
    const list = await res.json() as { name: string; url: string; apiVersion: number; nav: { label: string; icon?: string; route?: string }[]; settings: { id: string; label: string }[] }[];
    expect(list.map((p) => p.name)).toEqual(['demo']);
    expect(list[0]!.url).toBe(`/plugins/demo/web/${HASH}.js`);
    expect(list[0]!.apiVersion).toBe(1);
    expect(list[0]!.nav).toEqual([{ label: 'Demo world', icon: 'Bot', route: '' }]);
    // admin sees the same listing
    const adminRes = await app.request('/plugins/ui', auth(token));
    expect(((await adminRes.json()) as unknown[]).length).toBe(1);
  });

  it('?lang=cs localizes nav/settings labels and view strings from the plugin i18n web block', async () => {
    const { app, token } = await makeApp();
    const res = await app.request('/plugins/ui?lang=cs', auth(token));
    const list = await res.json() as { label?: string; nav: { label: string }[]; settings: { label: string }[]; strings: Record<string, string> }[];
    // The world's own name localizes like every other menu label — the sidebar groups a multi-page
    // plugin under it, so leaving it English would show one untranslated word in a translated menu.
    expect(list[0]!.label).toBe('Demo česky');
    expect(list[0]!.nav[0]!.label).toBe('Demo svět');
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
});
