import './globals.css';
import { GeistMono } from 'geist/font/mono';
import { Quicksand } from 'next/font/google';
import type { ReactNode } from 'react';

// Rounded display face for headings & nav. latin-ext is required for Czech diacritics
// (Přehled/Nastavení/…). Exposed as --font-quicksand, consumed via --font-display in tokens.css.
const quicksand = Quicksand({ subsets: ['latin', 'latin-ext'], weight: ['500', '600', '700'], variable: '--font-quicksand', display: 'swap' });
import { Shell } from '../components/shell/Shell';
import { en } from '../lib/i18n/dictionaries/en';

// Icons come from Next file conventions: app/icon.png → <link rel="icon"> and app/apple-icon.png →
// <link rel="apple-touch-icon">. Do NOT set metadata.icons here — declaring it overrides the file
// convention and drops the auto-generated favicon link.
export const metadata = {
  title: en.common.appName,
  manifest: '/manifest.json',
  appleWebApp: { capable: true, title: en.common.appName, statusBarStyle: 'black' as const },
};
// Reacts to the OS scheme so the mobile browser chrome matches the painted palette instead of a
// hardcoded black (the localStorage override can't be read from the server).
export const viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#000000' },
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
  ],
};

// Set data-theme BEFORE first paint from the per-device preference (localStorage 'orca:theme',
// falling back to the OS scheme) so there's no light/dark flash on reload. Kept in sync afterwards by
// ThemeProvider (lib/useTheme.tsx). `html` has suppressHydrationWarning so the attribute we add here
// doesn't trip React's markup check.
const NO_FLASH_THEME = `(function(){try{var t=localStorage.getItem('orca:theme');var d=t==='light'||t==='dark'?t:(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.setAttribute('data-theme',d);}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistMono.variable} ${quicksand.variable}`} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: NO_FLASH_THEME }} /></head>
      <body><Shell>{children}</Shell></body>
    </html>
  );
}
