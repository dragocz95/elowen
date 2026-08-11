import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThemeStore, sanitizeThemeManifest, THEME_COLOR_KEYS } from '../../src/store/themeStore.js';
import { readFileSync } from 'node:fs';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'themes-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const writeTheme = (name: string, manifest: unknown) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'theme.json'), JSON.stringify(manifest));
};
const valid = { displayName: 'Acme', brand: { agentName: 'Acme Bot', productName: 'Acme' }, colors: { accent: '#ff0000', 'accent-rgb': '255 0 0' } };

describe('sanitizeThemeManifest', () => {
  it('accepts a full valid manifest and normalizes it', () => {
    const m = sanitizeThemeManifest({ ...valid, fonts: { sans: "'Inter', sans-serif" }, text: { cs: { appName: 'Acme' } } });
    expect(m.brand).toEqual({ agentName: 'Acme Bot', productName: 'Acme' });
    expect(m.colors.accent).toBe('#ff0000');
    expect(m.fonts.sans).toBe("'Inter', sans-serif");
    expect(m.text.cs!.appName).toBe('Acme');
  });

  // The payload lands unauthenticated inside a server-rendered <style> block, so every rejection here
  // is a security boundary, not a lint: proven by mutation (each value WOULD otherwise flow through).
  it('rejects an unknown color key, a non-hex color and a malformed accent-rgb triple', () => {
    expect(() => sanitizeThemeManifest({ ...valid, colors: { evil: '#fff' } })).toThrow(/unknown color key/);
    expect(() => sanitizeThemeManifest({ ...valid, colors: { accent: 'red;}</style>' } })).toThrow(/hex color/);
    expect(() => sanitizeThemeManifest({ ...valid, colors: { 'accent-rgb': 'rgb(1,2,3)' } })).toThrow(/triple/);
  });

  it('rejects a font stack carrying CSS-breaking characters', () => {
    expect(() => sanitizeThemeManifest({ ...valid, fonts: { sans: 'x; background:url(//evil)' } })).toThrow(/font "sans"/);
  });

  it('rejects a missing displayName and an unsupported version', () => {
    expect(() => sanitizeThemeManifest({ brand: {} })).toThrow(/displayName/);
    expect(() => sanitizeThemeManifest({ ...valid, version: 2 })).toThrow(/version/);
  });

  it('rejects malformed text overrides (locale and key grammar)', () => {
    expect(() => sanitizeThemeManifest({ ...valid, text: { CZE: {} } })).toThrow(/locale/);
    expect(() => sanitizeThemeManifest({ ...valid, text: { cs: { '<img>': 'x' } } })).toThrow(/dictionary key/);
  });
});

describe('ThemeStore', () => {
  it('lists themes with validity and rejects bad folder names', () => {
    writeTheme('acme', valid);
    writeTheme('broken', { displayName: '' });
    mkdirSync(join(dir, 'Bad Name!'), { recursive: true });
    const store = new ThemeStore(dir);
    const list = store.list();
    expect(list.map((t) => t.name)).toEqual(['acme', 'broken']);
    expect(list[0]).toMatchObject({ valid: true, displayName: 'Acme' });
    expect(list[1]).toMatchObject({ valid: false });
    expect(list[1]!.error).toMatch(/displayName/);
  });

  it('get() returns null for an invalid theme, a missing theme and a traversal-shaped name', () => {
    writeTheme('broken', { nope: true });
    const store = new ThemeStore(dir);
    expect(store.get('broken')).toBeNull();
    expect(store.get('ghost')).toBeNull();
    expect(store.get('../etc')).toBeNull();
  });

  it('picks up a hand-edited manifest without a restart (mtime-keyed cache)', () => {
    writeTheme('acme', valid);
    const store = new ThemeStore(dir);
    expect(store.get('acme')!.manifest.displayName).toBe('Acme');
    writeFileSync(join(dir, 'acme', 'theme.json'), JSON.stringify({ ...valid, displayName: 'Acme 2' }));
    // Force a distinct mtime — same-millisecond writes would otherwise hide the edit from the cache key.
    utimesSync(join(dir, 'acme', 'theme.json'), new Date(), new Date(Date.now() + 5000));
    expect(store.get('acme')!.manifest.displayName).toBe('Acme 2');
  });

  it('swapping an asset alone bumps the version (assets stat outside the manifest cache)', () => {
    writeTheme('acme', valid);
    writeFileSync(join(dir, 'acme', 'logo.png'), Buffer.from('png-a'));
    const store = new ThemeStore(dir);
    const v1 = store.get('acme')!.version;
    writeFileSync(join(dir, 'acme', 'logo.png'), Buffer.from('png-bb'));
    utimesSync(join(dir, 'acme', 'logo.png'), new Date(), new Date(Date.now() + 5000));
    const v2 = store.get('acme')!.version;
    expect(v2).not.toBe(v1);
  });

  it('resolveAsset serves only whitelisted, present files', () => {
    writeTheme('acme', valid);
    writeFileSync(join(dir, 'acme', 'logo.png'), Buffer.from('png'));
    writeFileSync(join(dir, 'acme', 'secret.txt'), 'nope');
    const store = new ThemeStore(dir);
    expect(store.resolveAsset('acme', 'logo.png')?.path).toBe(join(dir, 'acme', 'logo.png'));
    expect(store.resolveAsset('acme', 'icon.png')).toBeNull(); // whitelisted but absent
    expect(store.resolveAsset('acme', 'secret.txt')).toBeNull();
    expect(store.resolveAsset('acme', '../acme/logo.png')).toBeNull();
  });

  it('an oversized asset is ignored entirely (not listed, not served)', () => {
    writeTheme('acme', valid);
    writeFileSync(join(dir, 'acme', 'logo.png'), Buffer.alloc(2 * 1024 * 1024 + 1));
    const store = new ThemeStore(dir);
    expect(store.get('acme')!.assets).toEqual([]);
    expect(store.resolveAsset('acme', 'logo.png')).toBeNull();
  });
});

// The color keys a theme may override must stay a SUBSET of the tokens the web actually defines —
// otherwise a theme could carry dead keys the UI silently ignores, or the web could rename a token
// and orphan every existing theme without anyone noticing.
describe('theme color keys contract', () => {
  it('every THEME_COLOR_KEY except accent-rgb exists as --color-* in web tokens.css', () => {
    const css = readFileSync(join(__dirname, '..', '..', 'web', 'app', 'styles', 'tokens.css'), 'utf-8');
    for (const key of THEME_COLOR_KEYS) {
      if (key === 'accent-rgb') continue; // composed variable, introduced by the theme injection itself
      expect(css, `--color-${key} missing from tokens.css`).toContain(`--color-${key}:`);
    }
  });
});
