import './globals.css';
import '../modules/settings/theme.css';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import type { ReactNode } from 'react';

import { Shell } from '../components/shell/Shell';
import { fetchThemePayload, buildThemeStyle } from '../lib/brandServer';
import { fetchPluginUiListing, fetchMe, readLocale } from '../lib/serverPrefetch';
import { activeSkin } from '../lib/skins';

// Every route renders per request — the brand payload is fetched live, so a theme switch must land on
// the next reload. This CANNOT be left to the `no-store` fetch inside fetchThemePayload: its failure
// backoff returns early WITHOUT touching fetch, and a render that hits that path uses no dynamic API at
// all, so Next classifies the route as static and bakes the built-in brand into the full route cache
// (exactly what happened when `next build` ran while the daemon was down).
export const dynamic = 'force-dynamic';

// Icons come from Next file conventions: app/icon.png → <link rel="icon"> and app/apple-icon.png →
// <link rel="apple-touch-icon">. Do NOT set metadata.icons here — declaring it overrides the file
// convention and drops the auto-generated favicon link.
// Title and PWA name follow the instance brand (white-label theme), resolved per request so a theme
// switch lands on the next reload without a rebuild.
export async function generateMetadata() {
  const theme = await fetchThemePayload();
  const appName = theme.text.en?.appName ?? theme.brand.productName;
  return {
    title: appName,
    manifest: '/manifest.webmanifest',
    appleWebApp: { capable: true, title: appName, statusBarStyle: 'black' as const },
  };
}

// Elowen is intentionally OLED-only. Browser chrome follows the same black canvas on every device.
// `viewportFit: cover` lays the app edge-to-edge so `env(safe-area-inset-*)` resolves (notch / home
// indicator, incl. the installed PWA); `interactiveWidget: resizes-content` shrinks the layout viewport
// (and therefore `100dvh`) when the soft keyboard opens, so a sticky bottom composer stays above it.
export const viewport = {
  colorScheme: 'dark' as const,
  themeColor: '#000000',
  viewportFit: 'cover' as const,
  interactiveWidget: 'resizes-content' as const,
};

// Apply the per-device effects preference before first paint. This prevents an opted-out device from
// briefly playing entrance or ambient motion while React hydrates. Theme is fixed in the markup.
const NO_FLASH_EFFECTS = `(function(){try{var m=localStorage.getItem('elowen:effects');m=m==='full'||m==='reduced'||m==='off'?m:'auto';var r=m==='auto'?(window.matchMedia('(prefers-reduced-motion: reduce)').matches?'reduced':'full'):m;document.documentElement.setAttribute('data-effects-mode',m);document.documentElement.setAttribute('data-effects',r);}catch(e){}})();`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Server-rendered theme overrides: the values are in the markup before first paint (no FOUC), and the
  // login screen — rendered before any token exists — already carries the instance brand.
  const theme = await fetchThemePayload();
  const themeStyle = buildThemeStyle(theme);
  // Server-prefetch what the navigation rail is made of, so it arrives COMPLETE in the HTML instead of
  // growing after the client's own fetches resolve (the layout shift this removes). Two halves: the
  // plugin worlds, and the identity — the system group renders admin destinations only once `is_admin`
  // is known. Issued together, because awaiting them in sequence would put both round-trips into TTFB.
  // The locale comes from the cookie the client mirrors its choice into, so the document is rendered in
  // the user's own language from the start and the listing seed matches the client's first-paint query
  // key. Null — logged out, 401/403, daemon down — renders exactly as before and the client queries
  // fill it in.
  const locale = await readLocale();
  const [pluginUi, me] = await Promise.all([fetchPluginUiListing(locale), fetchMe()]);
  // Compiled-in design skin (ELOWEN_SKIN env). All skins ship in every build scoped under
  // `:root[data-skin='…']`; without the attribute none of their rules match, so a skinless instance
  // renders byte-identical markup to a build from before skins existed.
  const skin = activeSkin();
  return (
    <html
      lang={locale}
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      data-theme="dark"
      {...(skin ? { 'data-skin': skin } : {})}
      data-effects-mode="auto"
      data-effects="full"
      style={{ backgroundColor: '#000000' }}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_EFFECTS }} />
        {themeStyle ? <style id="theme-overrides" dangerouslySetInnerHTML={{ __html: themeStyle }} /> : null}
      </head>
      <body style={{ backgroundColor: '#000000' }}><Shell theme={theme} pluginUiSeed={pluginUi ? { locale, listing: pluginUi } : null} meSeed={me} initialLocale={locale}>{children}</Shell></body>
    </html>
  );
}
