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
export function useBrand(): { appName: string; agentName: string; iconSrc: string; logoSrc: string } {
  const theme = useBrandTheme();
  const locale = useLocaleSafe();
  const appName = theme.text[locale]?.appName ?? theme.brand.productName;
  // Same shape check the server injection applies — a payload path that is not the daemon's own asset
  // route never becomes an <img> src.
  const asset = (path: string | undefined, fallback: string): string =>
    path && THEME_ASSET_PATH_RE.test(path) ? themeAssetUrl(path) : fallback;
  return {
    appName,
    agentName: theme.brand.agentName,
    iconSrc: asset(theme.assets.icon, '/icon.png'),
    logoSrc: asset(theme.assets.logo, '/elowen-logo.png'),
  };
}
