import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildThemeStyle, themeIcon } from '../../lib/brandServer';
import { BUILTIN_THEME, type ThemePayload } from '../../lib/brand';

const theme = (over: Partial<ThemePayload>): ThemePayload => ({ ...BUILTIN_THEME, ...over });

describe('buildThemeStyle', () => {
  it('renders nothing for the built-in brand — the default markup stays untouched', () => {
    expect(buildThemeStyle(BUILTIN_THEME)).toBe('');
  });

  // Whole-string assert on purpose: `toContain` alone would let a duplicate declaration, an extra rule
  // or a changed selector slip through the injection boundary unnoticed.
  it('emits exactly the token overrides, the primary triple and the logo swap', () => {
    const css = buildThemeStyle(theme({
      colors: { primary: '#ff0000', 'primary-rgb': '255 0 0' },
      fonts: { sans: "'Inter', sans-serif" },
      assets: { logo: '/public/theme/assets/logo.png?v=0123456789abcdef' },
    }));
    expect(css).toBe([
      ':root[data-theme] {',
      '--color-primary: #ff0000;',
      '--primary-rgb: 255 0 0;',
      "--font-sans: 'Inter', sans-serif;",
      '}',
      ":root[data-theme] .logo-adaptive { content: url('/api/public/theme/assets/logo.png?v=0123456789abcdef'); }",
    ].join('\n'));
  });

  // This string lands inside a server-rendered <style> block. The daemon validates too, but the web
  // must not TRUST that — a value that could close the declaration or the tag never passes here.
  it('drops any value that could escape the CSS declaration', () => {
    const css = buildThemeStyle(theme({
      colors: { primary: 'red;}</style><script>', 'primary-rgb': 'rgb(0,0,0)', bg: '#000000' },
      fonts: { mono: 'x; background:url(//evil)' },
      assets: { logo: '/public/theme/assets/../../../etc/passwd?v=0123456789abcdef' },
    }));
    expect(css).toContain('--color-bg: #000000;'); // the valid key still applies
    expect(css).not.toContain('script');
    expect(css).not.toContain('primary-rgb');
    expect(css).not.toContain('--font-mono');
    expect(css).not.toContain('logo-adaptive');
  });

  it('drops an unbalanced font quote (a CSS bad-string would eat the rest of its line)', () => {
    expect(buildThemeStyle(theme({ fonts: { sans: '"Inter' } }))).toBe('');
  });

  it('drops an out-of-range primary triple and a color key outside the token shape', () => {
    expect(buildThemeStyle(theme({ colors: { 'primary-rgb': '999 0 0' } }))).toBe('');
    expect(buildThemeStyle(theme({ colors: { 'Bad_Key': '#000000' } }))).toBe('');
  });
});

describe('themeIcon', () => {
  it('prefixes a valid asset path with the BFF proxy and rejects a malformed one', () => {
    expect(themeIcon(theme({ assets: { icon192: '/public/theme/assets/icon-192.png?v=0123456789abcdef' } }), 'icon192'))
      .toBe('/api/public/theme/assets/icon-192.png?v=0123456789abcdef');
    expect(themeIcon(theme({ assets: { icon512: 'https://evil.example/x.png' } }), 'icon512')).toBeNull();
    expect(themeIcon(BUILTIN_THEME, 'icon192')).toBeNull();
  });

  // Four raster slots that are NOT interchangeable: `favicon` is the tab, `icon` the static mascot the
  // avatar and the spatial scene render, `icon192`/`icon512` the installed-app and notification art.
  it('resolves each artwork slot independently', () => {
    const all = theme({ assets: {
      favicon: '/public/theme/assets/favicon.png?v=0123456789abcdef',
      icon: '/public/theme/assets/icon.png?v=0123456789abcdef',
      icon192: '/public/theme/assets/icon-192.png?v=0123456789abcdef',
    } });
    expect(themeIcon(all, 'favicon')).toBe('/api/public/theme/assets/favicon.png?v=0123456789abcdef');
    expect(themeIcon(all, 'icon')).toBe('/api/public/theme/assets/icon.png?v=0123456789abcdef');
    expect(themeIcon(all, 'icon192')).toBe('/api/public/theme/assets/icon-192.png?v=0123456789abcdef');
    // A theme shipping only a mascot has no separate tab mark; the layout then falls back to `icon`.
    expect(themeIcon(theme({ assets: { icon: '/public/theme/assets/icon.png?v=0123456789abcdef' } }), 'favicon')).toBeNull();
  });
});

// fetchThemePayload holds module state (last-known-good + failure backoff), so each test imports a
// FRESH module instance — and fetch is always stubbed: a test hitting the real network would silently
// change meaning with whatever daemon happens to run on the box.
describe('fetchThemePayload', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  const importFresh = async () => (await import('../../lib/brandServer')).fetchThemePayload;
  const themedBody = {
    brand: { agentName: 'Acme Bot', productName: 'Acme' },
    colors: { primary: '#ff0000' }, fonts: {}, text: {}, assets: {}, v: 'a'.repeat(16),
  };
  const okResponse = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

  it('falls back to the built-in brand when the fetch rejects and when the daemon answers non-OK', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await (await importFresh())()).toEqual(BUILTIN_THEME);
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 }) as Response));
    expect(await (await importFresh())()).toEqual(BUILTIN_THEME);
  });

  it('parses a themed payload and keeps serving it as last-known-good across a later failure', async () => {
    const fetchMock = vi.fn(async () => okResponse(themedBody));
    vi.stubGlobal('fetch', fetchMock);
    const fetchThemePayload = await importFresh();
    expect((await fetchThemePayload()).brand.productName).toBe('Acme');
    // The daemon goes away mid-flight (restart during deploy): the shell must keep the ACTIVE brand,
    // not flash back to Elowen on the next request.
    fetchMock.mockImplementation(async () => { throw new Error('down'); });
    expect((await fetchThemePayload()).brand.productName).toBe('Acme');
  });

  it('backs off after a failure instead of paying the timeout on every document', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('down'); });
    vi.stubGlobal('fetch', fetchMock);
    const fetchThemePayload = await importFresh();
    await fetchThemePayload();
    await fetchThemePayload();
    await fetchThemePayload();
    // Only the FIRST call may touch the network inside the backoff window — a hanging daemon otherwise
    // adds its full abort timeout to the TTFB of every page, the login screen included.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a payload without the brand shape', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ hello: 'world' })));
    expect(await (await importFresh())()).toEqual(BUILTIN_THEME);
  });
});
