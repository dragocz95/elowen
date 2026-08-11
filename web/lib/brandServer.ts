// Server-side only (imported from the root layout / manifest route — never from client components).
import { cache } from 'react';
import { daemonUrl } from './proxy';
import { BUILTIN_THEME, themeAssetUrl, THEME_ASSET_PATH_RE, type ThemePayload } from './brandShared';

/** Fetch the instance's white-label payload for server rendering (layout + manifest). `no-store`
 *  because the payload carries its own content version and a theme switch must land on the next
 *  reload, not after a build cache expires. Any failure — daemon down, timeout, bad JSON — falls
 *  back to the built-in brand so the shell always renders. Deduped per request via React cache. */
export const fetchThemePayload = cache(async (): Promise<ThemePayload> => {
  try {
    const res = await fetch(`${daemonUrl()}/public/theme`, { cache: 'no-store', signal: AbortSignal.timeout(2000) });
    if (!res.ok) return BUILTIN_THEME;
    const body = (await res.json()) as Partial<ThemePayload>;
    if (!body || typeof body !== 'object' || !body.brand?.agentName || !body.brand.productName) return BUILTIN_THEME;
    return {
      brand: { agentName: body.brand.agentName, productName: body.brand.productName },
      colors: body.colors ?? {}, fonts: body.fonts ?? {}, text: body.text ?? {},
      assets: body.assets ?? {}, v: typeof body.v === 'string' ? body.v : 'builtin',
    };
  } catch {
    return BUILTIN_THEME;
  }
});

// Defense-in-depth: the daemon already validates every value with these exact grammars, but the strings
// below land inside a server-rendered <style> block, so the injection boundary re-checks them — a
// compromised or older daemon must not be able to break out of a CSS declaration here.
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RGB_TRIPLE_RE = /^\d{1,3} \d{1,3} \d{1,3}$/;
const FONT_STACK_RE = /^[\w \-,'"]{1,200}$/;
const ASSET_PATH_RE = THEME_ASSET_PATH_RE;

/** A theme icon's browser URL (through the BFF proxy), or null when the theme does not carry it. */
export function themeIcon(theme: ThemePayload, slot: 'icon192' | 'icon512'): string | null {
  const path = theme.assets[slot];
  return path && ASSET_PATH_RE.test(path) ? themeAssetUrl(path) : null;
}

/** The `<style id="theme-overrides">` body: token overrides + the logo swap. Empty string when the
 *  theme changes nothing, so the default markup stays byte-identical without a theme. `:root[data-theme]`
 *  outranks the `@theme`-generated `:root` declarations regardless of stylesheet order. */
export function buildThemeStyle(theme: ThemePayload): string {
  const decls: string[] = [];
  for (const [key, value] of Object.entries(theme.colors)) {
    if (key === 'accent-rgb') { if (RGB_TRIPLE_RE.test(value)) decls.push(`--accent-rgb: ${value};`); continue; }
    if (/^[a-z-]{1,24}$/.test(key) && HEX_COLOR_RE.test(value)) decls.push(`--color-${key}: ${value};`);
  }
  if (theme.fonts.sans && FONT_STACK_RE.test(theme.fonts.sans)) decls.push(`--font-sans: ${theme.fonts.sans};`);
  if (theme.fonts.mono && FONT_STACK_RE.test(theme.fonts.mono)) decls.push(`--font-mono: ${theme.fonts.mono};`);
  const rules: string[] = [];
  if (decls.length) rules.push(`:root[data-theme] { ${decls.join(' ')} }`);
  // components.css swaps the wordmark via `content:` already — one override rule rebrands every <img>
  // that carries .logo-adaptive (login, setup, sidebar) without touching a component.
  if (theme.assets.logo && ASSET_PATH_RE.test(theme.assets.logo)) {
    rules.push(`.logo-adaptive { content: url('${themeAssetUrl(theme.assets.logo)}'); }`);
  }
  return rules.join('\n');
}
