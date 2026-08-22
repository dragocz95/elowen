import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestApp } from '../helpers/testApp.js';
import { ThemeStore } from '../../src/store/themeStore.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'themes-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

// The routes read the active theme from ELOWEN_THEME (deployment configuration, like the web's
// ELOWEN_SKIN) — there is no runtime selection to patch.
const activate = (name: string) => vi.stubEnv('ELOWEN_THEME', name);

const writeTheme = (name: string) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'theme.json'), JSON.stringify({
    displayName: 'Acme', brand: { agentName: 'Acme Bot', productName: 'Acme' },
    colors: { accent: '#ff0000' }, text: { cs: { appName: 'Acme' } },
  }));
  writeFileSync(join(dir, name, 'logo.png'), Buffer.from('png'));
};

const makeApp = async () => makeTestApp({ extra: { themes: new ThemeStore(dir) } });

describe('GET /public/theme', () => {
  // The login screen renders the brand before any token exists — this route working WITHOUT auth is
  // the feature, not an oversight.
  it('serves the built-in brand unauthenticated when no theme is active', async () => {
    const { app } = await makeApp();
    const res = await app.request('/public/theme');
    expect(res.status).toBe(200);
    const body = await res.json() as { brand: { agentName: string; productName: string }; colors: object; assets: object; v: string };
    expect(body.brand).toEqual({ agentName: 'Elowen', productName: 'Elowen' });
    expect(body.colors).toEqual({});
    expect(body.assets).toEqual({});
    expect(body.v).toBe('builtin');
  });

  it('serves the active theme payload with versioned asset URLs', async () => {
    writeTheme('acme');
    activate('acme');
    const { app } = await makeApp();
    const body = await (await app.request('/public/theme')).json() as {
      brand: { agentName: string; productName: string }; colors: Record<string, string>;
      text: Record<string, Record<string, string>>; assets: { logo?: string }; v: string;
    };
    expect(body.brand).toEqual({ agentName: 'Acme Bot', productName: 'Acme' });
    expect(body.colors.accent).toBe('#ff0000');
    expect(body.text.cs!.appName).toBe('Acme');
    expect(body.assets.logo).toMatch(/^\/public\/theme\/assets\/logo\.png\?v=[0-9a-f]{16}$/);
    expect(body.v).toMatch(/^[0-9a-f]{16}$/);
  });

  // The flag is worthless unless it survives the whole way to the browser, and this route is the only
  // place it crosses out of the daemon. Both directions pinned: the default must reach a theme that
  // never mentions it, and an explicit false must not be dropped as "just a default".
  it('carries mascotScene, defaulting to true and honouring an explicit false', async () => {
    const read = async () => ((await (await (await makeApp()).app.request('/public/theme')).json()) as { mascotScene: boolean }).mascotScene;
    expect(await read()).toBe(true); // no theme active at all
    writeTheme('acme');
    activate('acme');
    expect(await read()).toBe(true); // theme.json says nothing about it
    writeFileSync(join(dir, 'acme', 'theme.json'), JSON.stringify({
      displayName: 'Acme', brand: { agentName: 'Acme Bot', productName: 'Acme' }, mascotScene: false,
    }));
    expect(await read()).toBe(false);
  });

  it('an explicit configured agentName still wins over the theme in the public payload', async () => {
    writeTheme('acme');
    activate('acme');
    const { app, deps } = await makeApp();
    deps.config.update({ brain: { agentName: 'Jarvis' } });
    const body = await (await app.request('/public/theme')).json() as { brand: { agentName: string; productName: string } };
    expect(body.brand).toEqual({ agentName: 'Jarvis', productName: 'Acme' });
  });

  it('a theme name pointing at a missing folder falls back to the built-in brand', async () => {
    activate('ghost');
    const { app } = await makeApp();
    const body = await (await app.request('/public/theme')).json() as { v: string };
    expect(body.v).toBe('builtin');
  });

  // A malformed env value must degrade to the built-in brand, never to an error path an
  // unauthenticated request could probe.
  it('a grammar-violating ELOWEN_THEME reads as no theme', async () => {
    writeTheme('acme');
    activate('../acme');
    const { app } = await makeApp();
    const body = await (await app.request('/public/theme')).json() as { v: string };
    expect(body.v).toBe('builtin');
  });

  // The only unauthenticated route touching DB + filesystem: without shared caching a request flood
  // pays the full stat/hash cost every time; the ETag covers a persona rename with no theme (where `v`
  // alone stays 'builtin').
  it('carries a shared max-age and answers a matching If-None-Match with 304', async () => {
    const { app } = await makeApp();
    const res = await app.request('/public/theme');
    expect(res.headers.get('cache-control')).toContain('max-age=60');
    const etag = res.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
    const revalidated = await app.request('/public/theme', { headers: { 'if-none-match': etag! } });
    expect(revalidated.status).toBe(304);
  });

  // The client (web layout + CLI useBrand re-check) validates asset paths against the shape published in
  // web/lib/brandShared.ts. The daemon composes its URLs by string interpolation, so the agreement would
  // otherwise be accidental — extract the web regex from source and hold both sides together.
  it('every emitted asset URL matches the web client re-validation shape', async () => {
    writeTheme('acme');
    for (const f of ['icon.png', 'icon-192.png', 'icon-512.png', 'favicon.png']) writeFileSync(join(dir, 'acme', f), Buffer.from('png'));
    writeFileSync(join(dir, 'acme', 'mascot.svg'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    activate('acme');
    const { app } = await makeApp();
    const src = readFileSync(join(__dirname, '..', '..', 'web', 'lib', 'brandShared.ts'), 'utf-8');
    const shape = src.match(/THEME_ASSET_PATH_RE = \/([^\n]+)\/;/)?.[1];
    expect(shape, 'THEME_ASSET_PATH_RE not found in web/lib/brandShared.ts').toBeTruthy();
    const webRe = new RegExp(shape!.replace(/\\\//g, '/'));
    const body = await (await app.request('/public/theme')).json() as { assets: Record<string, string> };
    const urls = Object.values(body.assets);
    expect(urls).toHaveLength(6);
    for (const url of urls) expect(url, `web boundary would reject "${url}"`).toMatch(webRe);
  });

  // The tab mark is its own slot precisely so it does NOT land on the agent avatar, which renders
  // `icon`. Publishing them under one key would put a favicon-sized logo on the mascot.
  it('publishes the favicon under its own key, separate from the static mascot', async () => {
    writeTheme('acme');
    writeFileSync(join(dir, 'acme', 'icon.png'), Buffer.from('mascot'));
    writeFileSync(join(dir, 'acme', 'favicon.png'), Buffer.from('mark'));
    activate('acme');
    const { app } = await makeApp();
    const body = await (await app.request('/public/theme')).json() as { assets: Record<string, string> };
    expect(body.assets.icon).toMatch(/\/public\/theme\/assets\/icon\.png\?v=/);
    expect(body.assets.favicon).toMatch(/\/public\/theme\/assets\/favicon\.png\?v=/);
    expect(body.assets.favicon).not.toBe(body.assets.icon);
    expect((await app.request('/public/theme/assets/favicon.png')).status).toBe(200);
  });
});

describe('GET /public/theme/assets/:file', () => {
  it('serves a whitelisted PNG of the active theme with immutable caching and nosniff', async () => {
    writeTheme('acme');
    activate('acme');
    const { app } = await makeApp();
    const res = await app.request('/public/theme/assets/logo.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('png');
  });

  // The animated mascot is the whitelist's one SVG: it must go out as image/svg+xml (an <img> ignores
  // a PNG-typed SVG) with a no-script CSP so a direct navigation cannot execute operator markup.
  it('serves the mascot SVG with its own content-type and a no-script CSP', async () => {
    writeTheme('acme');
    writeFileSync(join(dir, 'acme', 'mascot.svg'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    activate('acme');
    const { app } = await makeApp();
    const res = await app.request('/public/theme/assets/mascot.svg');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    // and the PNG route is untouched by the branch
    const png = await app.request('/public/theme/assets/logo.png');
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(png.headers.get('content-security-policy')).toBeNull();
  });

  // The CLI art is the whitelist's one non-image: it is escape sequences, so nothing downstream may be
  // invited to interpret it as markup or as an image.
  it('serves the CLI mascot art as plain text and advertises it in the payload', async () => {
    writeTheme('acme');
    writeFileSync(join(dir, 'acme', 'mascot.ans'), '\x1b[38;2;1;2;3m\u2580\x1b[0m');
    activate('acme');
    const { app } = await makeApp();
    const body = await (await app.request('/public/theme')).json() as { assets: Record<string, string> };
    expect(body.assets.cliMascot).toMatch(/^\/public\/theme\/assets\/mascot\.ans\?v=[0-9a-f]{16}$/);
    const res = await app.request('/public/theme/assets/mascot.ans');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toContain('\u2580');
  });

  it('404s on a non-whitelisted file, with no active theme, and for an absent asset', async () => {
    writeTheme('acme');
    activate('acme');
    const { app } = await makeApp();
    // theme.json itself must NOT be reachable even while the theme is active
    expect((await app.request('/public/theme/assets/theme.json')).status).toBe(404);
    expect((await app.request('/public/theme/assets/icon.png')).status).toBe(404);
    vi.unstubAllEnvs();
    expect((await app.request('/public/theme/assets/logo.png')).status).toBe(404);
  });

  // The response is `immutable` for a year — only honest if a versioned URL can never change meaning. A
  // `?v=` from another theme generation (stale tab, shared-cache replay after a switch) must 404 rather
  // than silently bind the OLD URL to the NEW theme's bytes in every cache along the way.
  it('404s a version query from a different theme generation, serves the current one', async () => {
    writeTheme('acme');
    activate('acme');
    const { app } = await makeApp();
    const body = await (await app.request('/public/theme')).json() as { assets: { logo: string } };
    expect((await app.request(body.assets.logo)).status).toBe(200);
    expect((await app.request('/public/theme/assets/logo.png?v=' + '0'.repeat(16))).status).toBe(404);
  });

  // Pins the byte cache's mtime key: mutating the freshness check to `if (!cached)` (stale bytes served
  // forever after a logo swap) turns this red.
  it('serves fresh bytes after an asset is swapped on disk', async () => {
    writeTheme('acme');
    activate('acme');
    const { app } = await makeApp();
    expect(Buffer.from(await (await app.request('/public/theme/assets/logo.png')).arrayBuffer()).toString()).toBe('png');
    writeFileSync(join(dir, 'acme', 'logo.png'), Buffer.from('png-v2'));
    utimesSync(join(dir, 'acme', 'logo.png'), new Date(), new Date(Date.now() + 5000));
    expect(Buffer.from(await (await app.request('/public/theme/assets/logo.png')).arrayBuffer()).toString()).toBe('png-v2');
  });
});

describe('PUT /config live brand apply', () => {
  const put = (token: string, body: unknown) => ({
    method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('an agentName change triggers applyBrandChange; an unrelated patch does not', async () => {
    const applyBrandChange = vi.fn(async () => {});
    const { app, token } = await makeTestApp({ extra: { themes: new ThemeStore(dir), brain: { applyBrandChange } as never } });
    await app.request('/config', put(token, { brain: { agentName: 'Jarvis' } }));
    expect(applyBrandChange).toHaveBeenCalledTimes(1);
    await app.request('/config', put(token, { webPushContact: 'https://x.example' }));
    expect(applyBrandChange).toHaveBeenCalledTimes(1); // unrelated save must not respawn every session
    // Saving the SAME value again is not a change — the respawn is expensive (full prompt re-cache).
    await app.request('/config', put(token, { brain: { agentName: 'Jarvis' } }));
    expect(applyBrandChange).toHaveBeenCalledTimes(1);
  });

  // Each sweep restarts EVERY session (full prompt-cache re-warm), and in setup mode the PUT is reachable
  // unauthenticated — so N rapid saves must collapse to the running sweep plus ONE trailing one that
  // re-reads the fresh config, never a queue of N.
  it('rapid brand changes collapse to one running + one trailing sweep', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const applyBrandChange = vi.fn(() => gate);
    const { app, token } = await makeTestApp({ extra: { themes: new ThemeStore(dir), brain: { applyBrandChange } as never } });
    await app.request('/config', put(token, { brain: { agentName: 'Aa' } }));
    await app.request('/config', put(token, { brain: { agentName: 'Bb' } }));
    await app.request('/config', put(token, { brain: { agentName: 'Cc' } }));
    expect(applyBrandChange).toHaveBeenCalledTimes(1); // first sweep still running, the rest queued
    release();
    await vi.waitFor(() => expect(applyBrandChange).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 10)); // give a hypothetical third run the chance to fire
    expect(applyBrandChange).toHaveBeenCalledTimes(2);
  });
});
