import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestApp } from '../helpers/testApp.js';
import { ThemeStore } from '../../src/store/themeStore.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'themes-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

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
    const { app, deps } = await makeApp();
    deps.config.update({ theme: { active: 'acme' } });
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

  it('an explicit configured agentName still wins over the theme in the public payload', async () => {
    writeTheme('acme');
    const { app, deps } = await makeApp();
    deps.config.update({ theme: { active: 'acme' }, brain: { agentName: 'Jarvis' } });
    const body = await (await app.request('/public/theme')).json() as { brand: { agentName: string; productName: string } };
    expect(body.brand).toEqual({ agentName: 'Jarvis', productName: 'Acme' });
  });

  it('a theme name pointing at a missing folder falls back to the built-in brand', async () => {
    const { app, deps } = await makeApp();
    deps.config.update({ theme: { active: 'ghost' } });
    const body = await (await app.request('/public/theme')).json() as { v: string };
    expect(body.v).toBe('builtin');
  });
});

describe('GET /public/theme/assets/:file', () => {
  it('serves a whitelisted PNG of the active theme with immutable caching and nosniff', async () => {
    writeTheme('acme');
    const { app, deps } = await makeApp();
    deps.config.update({ theme: { active: 'acme' } });
    const res = await app.request('/public/theme/assets/logo.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('png');
  });

  it('404s on a non-whitelisted file, with no active theme, and for an absent asset', async () => {
    writeTheme('acme');
    const { app, deps } = await makeApp();
    // theme.json itself must NOT be reachable even while the theme is active
    deps.config.update({ theme: { active: 'acme' } });
    expect((await app.request('/public/theme/assets/theme.json')).status).toBe(404);
    expect((await app.request('/public/theme/assets/icon.png')).status).toBe(404);
    deps.config.update({ theme: { active: null } });
    expect((await app.request('/public/theme/assets/logo.png')).status).toBe(404);
  });
});

describe('GET /themes (admin list)', () => {
  it('lists theme folders with validity and reports the active selection', async () => {
    writeTheme('acme');
    const { app, token, deps } = await makeApp();
    deps.config.update({ theme: { active: 'acme' } });
    const res = await app.request('/themes', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as { themes: { name: string; valid: boolean }[]; active: string | null };
    expect(body.themes).toEqual([{ name: 'acme', displayName: 'Acme', valid: true }]);
    expect(body.active).toBe('acme');
  });
});

describe('PUT /config theme patch + live brand apply', () => {
  const put = (token: string, body: unknown) => ({
    method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('persists theme.active, treats null as a real value, and rejects a malformed name with 400', async () => {
    const { app, token, deps } = await makeApp();
    expect((await app.request('/config', put(token, { theme: { active: 'acme' } }))).status).toBe(200);
    expect(deps.config.get().theme.active).toBe('acme');
    // Bad grammar answers 400 AND leaves the selection untouched — silently deactivating the theme
    // while reporting success would be a lie to the settings UI.
    expect((await app.request('/config', put(token, { theme: { active: '../etc' } }))).status).toBe(400);
    expect(deps.config.get().theme.active).toBe('acme');
    expect((await app.request('/config', put(token, { theme: { active: null } }))).status).toBe(200);
    expect(deps.config.get().theme.active).toBeNull();
  });

  it('a theme or agentName change triggers applyBrandChange; an unrelated patch does not', async () => {
    const applyBrandChange = vi.fn(async () => {});
    const { app, token } = await makeTestApp({ extra: { themes: new ThemeStore(dir), brain: { applyBrandChange } as never } });
    await app.request('/config', put(token, { theme: { active: 'acme' } }));
    expect(applyBrandChange).toHaveBeenCalledTimes(1);
    await app.request('/config', put(token, { brain: { agentName: 'Jarvis' } }));
    expect(applyBrandChange).toHaveBeenCalledTimes(2);
    await app.request('/config', put(token, { webPushContact: 'https://x.example' }));
    expect(applyBrandChange).toHaveBeenCalledTimes(2); // unrelated save must not respawn every session
    // Saving the SAME value again is not a change — the respawn is expensive (full prompt re-cache).
    await app.request('/config', put(token, { theme: { active: 'acme' } }));
    expect(applyBrandChange).toHaveBeenCalledTimes(2);
  });
});
