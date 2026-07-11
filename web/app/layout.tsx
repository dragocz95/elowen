import './globals.css';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import type { ReactNode } from 'react';

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

// Elowen is intentionally OLED-only. Browser chrome follows the same black canvas on every device.
export const viewport = {
  colorScheme: 'dark' as const,
  themeColor: '#000000',
};

// Apply the per-device effects preference before first paint. This prevents an opted-out device from
// briefly playing entrance or ambient motion while React hydrates. Theme is fixed in the markup.
const NO_FLASH_EFFECTS = `(function(){try{var m=localStorage.getItem('elowen:effects');m=m==='full'||m==='reduced'||m==='off'?m:'auto';var r=m==='auto'?(window.matchMedia('(prefers-reduced-motion: reduce)').matches?'reduced':'full'):m;document.documentElement.setAttribute('data-effects-mode',m);document.documentElement.setAttribute('data-effects',r);}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
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
      <head><script dangerouslySetInnerHTML={{ __html: NO_FLASH_EFFECTS }} /></head>
      <body style={{ backgroundColor: '#000000' }}><Shell>{children}</Shell></body>
    </html>
  );
}
