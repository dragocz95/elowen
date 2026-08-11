// Shared between the server (layout/manifest) and the client (BrandProvider). Deliberately NOT a
// 'use client' module: importing values from one into server code hands back client-reference proxies,
// not the objects.

/** The daemon's public white-label payload (GET /public/theme). Colors/fonts are consumed server-side
 *  in the root layout; the client context carries the parts components render themselves — names and
 *  asset URLs. With no theme active the daemon returns the built-in brand and everything falls back. */
export interface ThemePayload {
  brand: { agentName: string; productName: string };
  colors: Record<string, string>;
  fonts: { sans?: string; mono?: string };
  /** Per-locale shallow UI text overrides (documented key: `appName`). */
  text: Record<string, Record<string, string>>;
  /** Daemon asset paths (`/public/theme/assets/…?v=…`) — prefix with `/api` for the browser. */
  assets: Partial<Record<'logo' | 'icon' | 'icon192' | 'icon512', string>>;
  v: string;
}

export const BUILTIN_THEME: ThemePayload = {
  brand: { agentName: 'Elowen', productName: 'Elowen' },
  colors: {}, fonts: {}, text: {}, assets: {}, v: 'builtin',
};

/** The browser reaches daemon paths through the same-origin BFF proxy. */
export const themeAssetUrl = (daemonPath: string): string => `/api${daemonPath}`;
