'use client';
import { createContext, useContext, type ReactNode } from 'react';
import { BUILTIN_THEME, type ThemePayload } from './brandShared';

const BrandThemeContext = createContext<ThemePayload>(BUILTIN_THEME);

export function BrandThemeProvider({ theme, children }: { theme: ThemePayload; children: ReactNode }) {
  return <BrandThemeContext.Provider value={theme}>{children}</BrandThemeContext.Provider>;
}

export function useBrandTheme(): ThemePayload {
  return useContext(BrandThemeContext);
}
