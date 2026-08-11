import { describe, it, expect } from 'vitest';
import { buildThemeStyle, themeIcon, fetchThemePayload } from '../../lib/brandServer';
import { BUILTIN_THEME, type ThemePayload } from '../../lib/brand';

const theme = (over: Partial<ThemePayload>): ThemePayload => ({ ...BUILTIN_THEME, ...over });

describe('buildThemeStyle', () => {
  it('renders nothing for the built-in brand — the default markup stays untouched', () => {
    expect(buildThemeStyle(BUILTIN_THEME)).toBe('');
  });

  it('emits token overrides, the accent triple and the logo swap', () => {
    const css = buildThemeStyle(theme({
      colors: { accent: '#ff0000', 'accent-rgb': '255 0 0' },
      fonts: { sans: "'Inter', sans-serif" },
      assets: { logo: '/public/theme/assets/logo.png?v=0123456789abcdef' },
    }));
    expect(css).toContain('--color-accent: #ff0000;');
    expect(css).toContain('--accent-rgb: 255 0 0;');
    expect(css).toContain("--font-sans: 'Inter', sans-serif;");
    expect(css).toContain(".logo-adaptive { content: url('/api/public/theme/assets/logo.png?v=0123456789abcdef'); }");
  });

  // This string lands inside a server-rendered <style> block. The daemon validates too, but the web
  // must not TRUST that — a value that could close the declaration or the tag never passes here.
  it('drops any value that could escape the CSS declaration', () => {
    const css = buildThemeStyle(theme({
      colors: { accent: 'red;}</style><script>', 'accent-rgb': 'rgb(0,0,0)', bg: '#000000' },
      fonts: { mono: 'x; background:url(//evil)' },
      assets: { logo: '/public/theme/assets/../../../etc/passwd?v=0123456789abcdef' },
    }));
    expect(css).toContain('--color-bg: #000000;'); // the valid key still applies
    expect(css).not.toContain('script');
    expect(css).not.toContain('accent-rgb');
    expect(css).not.toContain('--font-mono');
    expect(css).not.toContain('logo-adaptive');
  });
});

describe('themeIcon', () => {
  it('prefixes a valid asset path with the BFF proxy and rejects a malformed one', () => {
    expect(themeIcon(theme({ assets: { icon192: '/public/theme/assets/icon-192.png?v=0123456789abcdef' } }), 'icon192'))
      .toBe('/api/public/theme/assets/icon-192.png?v=0123456789abcdef');
    expect(themeIcon(theme({ assets: { icon512: 'https://evil.example/x.png' } }), 'icon512')).toBeNull();
    expect(themeIcon(BUILTIN_THEME, 'icon192')).toBeNull();
  });
});

describe('fetchThemePayload', () => {
  it('falls back to the built-in brand when the daemon is unreachable', async () => {
    // The test env has no daemon on ELOWEN_DAEMON_URL — the fetch rejects and the fallback must hold.
    expect(await fetchThemePayload()).toEqual(BUILTIN_THEME);
  });
});
