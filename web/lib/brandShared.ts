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
  /** Daemon asset paths (`/public/theme/assets/…?v=…`) — prefix with `/api` for the browser.
   *  `icon` is the STATIC MASCOT (agent avatar, spatial-scene texture); `favicon` is the browser tab
   *  alone. Keeping them apart is what lets a brand put a compact mark in the tab without it turning
   *  up on the avatar. */
  assets: Partial<Record<'logo' | 'icon' | 'icon192' | 'icon512' | 'favicon' | 'mascot', string>>;
  /** Whether the workspace hero may render its WebGL mascot scene. False keeps the mascot a plain
   *  image — for a brand whose artwork is a flat illustration rather than a sprite. */
  mascotScene: boolean;
  v: string;
}

export const BUILTIN_THEME: ThemePayload = {
  brand: { agentName: 'Elowen', productName: 'Elowen' },
  colors: {}, fonts: {}, text: {}, assets: {}, mascotScene: true, v: 'builtin',
};

/** The browser reaches daemon paths through the same-origin BFF proxy. */
export const themeAssetUrl = (daemonPath: string): string => `/api${daemonPath}`;

/** The only asset-path shape the daemon ever emits. Both the server style injection and the client
 *  useBrand() re-check payload paths against it, so a hostile payload cannot steer an <img>/url() at an
 *  arbitrary daemon route. */
export const THEME_ASSET_PATH_RE = /^\/public\/theme\/assets\/[a-z0-9-]+\.(png|svg)\?v=[0-9a-f]{16}$/;
