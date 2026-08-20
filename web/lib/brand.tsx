'use client';
import type { ReactNode } from 'react';
import { useLocaleSafe } from './i18n/context';
import { BrandThemeProvider, useBrandTheme } from './brandContext';
import { themeAssetUrl, THEME_ASSET_PATH_RE, type ThemePayload } from './brandShared';

export { BUILTIN_THEME, type ThemePayload } from './brandShared';

export function BrandProvider({ theme, children }: { theme: ThemePayload; children: ReactNode }) {
  return <BrandThemeProvider theme={theme}>{children}</BrandThemeProvider>;
}

/** The resolved brand for the CURRENT locale: display names plus the mascot/logo sources every
 *  component should render instead of the hardcoded Elowen assets. */
export function useBrand(): { appName: string; agentName: string; iconSrc: string; logoSrc: string; mascotSrc: string; mascotAnimated: boolean } {
  const theme = useBrandTheme();
  const locale = useLocaleSafe();
  const appName = theme.text[locale]?.appName ?? theme.brand.productName;
  // Same shape check the server injection applies — a payload path that is not the daemon's own asset
  // route never becomes an <img> src.
  const asset = (path: string | undefined, fallback: string): string =>
    path && THEME_ASSET_PATH_RE.test(path) ? themeAssetUrl(path) : fallback;
  const iconSrc = asset(theme.assets.icon, '/icon.png');
  return {
    appName,
    agentName: theme.brand.agentName,
    iconSrc,
    logoSrc: asset(theme.assets.logo, '/elowen-logo.png'),
    // The mascot prefers the theme's animated SVG (CSS animations run inside <img>) and falls back to
    // the static icon. `mascotAnimated` tells consumers the source is the SVG — the WebGL scene skips
    // itself then, since a texture snapshot would freeze the very animation the asset exists for.
    mascotSrc: asset(theme.assets.mascot, iconSrc),
    mascotAnimated: !!theme.assets.mascot && THEME_ASSET_PATH_RE.test(theme.assets.mascot),
  };
}
