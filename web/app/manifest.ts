import type { MetadataRoute } from 'next';
import { fetchThemePayload, themeIcon } from '../lib/brandServer';

// The PWA manifest follows the instance brand: name and icons come from the active white-label theme,
// falling back to the bundled Elowen assets. Dynamic (replaces the old static public/manifest.json)
// so a theme switch renames the installed app without a web rebuild.
export const dynamic = 'force-dynamic';

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const theme = await fetchThemePayload();
  const appName = theme.text.en?.appName ?? theme.brand.productName;
  const icon192 = themeIcon(theme, 'icon192') ?? '/android-chrome-192x192.png';
  const icon512 = themeIcon(theme, 'icon512') ?? '/android-chrome-512x512.png';
  return {
    name: appName,
    short_name: appName,
    start_url: '/',
    display: 'standalone',
    background_color: '#000000',
    theme_color: '#000000',
    icons: [
      { src: icon192, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: icon512, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: icon192, sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: icon512, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
