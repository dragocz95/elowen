// Server-side only (imported from the root layout / manifest route — never from client components).
import { cache } from 'react';
import { daemonUrl } from './proxy';
import { BUILTIN_THEME, themeAssetUrl, THEME_ASSET_PATH_RE, type ThemePayload } from './brandShared';

/** After a failed fetch the last known payload is served without retrying for this long. A HEALTHY
 *  daemon answers /public/theme in ~1 ms, so per-request fetching keeps a theme switch instant — the
 *  backoff exists for a HANGING daemon, where every document (the login page included) would otherwise
 *  pay the full abort timeout in its TTFB on every request. */
const FAILURE_BACKOFF_MS = 5_000;
let lastKnown: ThemePayload | null = null;
let failedAt = 0;

/** Fetch the instance's white-label payload for server rendering (layout + manifest). `no-store`
 *  because the payload carries its own content version and a theme switch must land on the next
 *  reload, not after a build cache expires. Any failure — daemon down, timeout, bad JSON — falls
 *  back to the last known payload (built-in brand before the first success) so the shell always
 *  renders. Deduped per request via React cache. */
export const fetchThemePayload = cache(async (): Promise<ThemePayload> => {
  if (failedAt && Date.now() - failedAt < FAILURE_BACKOFF_MS) return lastKnown ?? BUILTIN_THEME;
  try {
    const res = await fetch(`${daemonUrl()}/public/theme`, { cache: 'no-store', signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = (await res.json()) as Partial<ThemePayload>;
    if (!body || typeof body !== 'object' || !body.brand?.agentName || !body.brand.productName) throw new Error('malformed payload');
    const payload: ThemePayload = {
      brand: { agentName: body.brand.agentName, productName: body.brand.productName },
      colors: body.colors ?? {}, fonts: body.fonts ?? {}, text: body.text ?? {},
      assets: body.assets ?? {}, v: typeof body.v === 'string' ? body.v : 'builtin',
    };
    failedAt = 0;
    lastKnown = payload;
    return payload;
  } catch {
    failedAt = Date.now();
    return lastKnown ?? BUILTIN_THEME;
  }
});

// Defense-in-depth: the daemon already validates every value with these exact grammars, but the strings
// below land inside a server-rendered <style> block, so the injection boundary re-checks them — a
// compromised or older daemon must not be able to break out of a CSS declaration here.
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RGB_TRIPLE_RE = /^\d{1,3} \d{1,3} \d{1,3}$/;
const FONT_STACK_RE = /^[\w \-,'"]{1,200}$/;

/** An unbalanced quote opens a CSS bad-string that consumes to end of line — not an escape, but it
 *  would silently swallow every later declaration on the same line. */
const quotesBalanced = (v: string): boolean =>
  (v.match(/"/g) ?? []).length % 2 === 0 && (v.match(/'/g) ?? []).length % 2 === 0;

const validFont = (v: string): boolean => FONT_STACK_RE.test(v) && quotesBalanced(v);

/** A theme icon's browser URL (through the BFF proxy), or null when the theme does not carry it. */
export function themeIcon(theme: ThemePayload, slot: 'icon192' | 'icon512'): string | null {
  const path = theme.assets[slot];
  return path && THEME_ASSET_PATH_RE.test(path) ? themeAssetUrl(path) : null;
}

/** The `<style id="theme-overrides">` body: token overrides + the logo swap. Empty string when the
 *  theme changes nothing, so the default markup stays byte-identical without a theme. `:root[data-theme]`
 *  outranks the `@theme`-generated `:root` declarations regardless of stylesheet order. Each declaration
 *  is emitted on its OWN line: a CSS bad-string (however it might slip through) eats to end of line, so
 *  per-line emission caps the blast radius at one declaration instead of the rest of the rule. */
export function buildThemeStyle(theme: ThemePayload): string {
  const decls: string[] = [];
  for (const [key, value] of Object.entries(theme.colors)) {
    if (typeof value !== 'string') continue;
    if (key === 'accent-rgb') {
      if (RGB_TRIPLE_RE.test(value) && value.split(' ').every((n) => Number(n) <= 255)) decls.push(`--accent-rgb: ${value};`);
      continue;
    }
    if (/^[a-z-]{1,24}$/.test(key) && HEX_COLOR_RE.test(value)) decls.push(`--color-${key}: ${value};`);
  }
  if (theme.fonts.sans && validFont(theme.fonts.sans)) decls.push(`--font-sans: ${theme.fonts.sans};`);
  if (theme.fonts.mono && validFont(theme.fonts.mono)) decls.push(`--font-mono: ${theme.fonts.mono};`);
  const rules: string[] = [];
  if (decls.length) rules.push(`:root[data-theme] {\n${decls.join('\n')}\n}`);
  // components.css swaps the wordmark via `content:` already — one override rule rebrands every <img>
  // that carries .logo-adaptive (login, setup, sidebar) without touching a component. The rule is
  // prefixed :root[data-theme] so it outranks the components.css declaration by specificity instead of
  // depending on React's stylesheet-hoisting order.
  if (theme.assets.logo && THEME_ASSET_PATH_RE.test(theme.assets.logo)) {
    rules.push(`:root[data-theme] .logo-adaptive { content: url('${themeAssetUrl(theme.assets.logo)}'); }`);
  }
  return rules.join('\n');
}
