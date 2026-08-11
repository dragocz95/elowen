import './globals.css';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import type { ReactNode } from 'react';

import { Shell } from '../components/shell/Shell';
import { fetchThemePayload, buildThemeStyle } from '../lib/brandServer';

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
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      data-theme="dark"
      data-effects-mode="auto"
      data-effects="full"
      style={{ backgroundColor: '#000000' }}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_EFFECTS }} />
        {themeStyle ? <style id="theme-overrides" dangerouslySetInnerHTML={{ __html: themeStyle }} /> : null}
      </head>
      <body style={{ backgroundColor: '#000000' }}><Shell theme={theme}>{children}</Shell></body>
    </html>
  );
}
