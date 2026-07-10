'use client';
import { createContext, useCallback, useContext, useEffect, type ReactNode } from 'react';

/**
 * Compatibility facade for consumers that still need a Monaco/xterm theme value.
 *
 * Elowen now has one intentional OLED palette. The legacy union types and setter stay exported so
 * plugins and shared controls compiled against the earlier API do not break, but every request
 * resolves to dark and stale per-device theme preferences are discarded.
 */
export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

interface ThemeValue {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
}

const DARK_VALUE = {
  theme: 'dark',
  resolvedTheme: 'dark',
} as const;

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const applyDark = useCallback((_theme?: Theme) => {
    document.documentElement.setAttribute('data-theme', 'dark');
    try { localStorage.removeItem('elowen:theme'); } catch { /* unavailable storage is harmless */ }
  }, []);

  useEffect(() => { applyDark(); }, [applyDark]);

  return (
    <ThemeContext.Provider value={{ ...DARK_VALUE, setTheme: applyDark }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within ThemeProvider');
  return context;
}
