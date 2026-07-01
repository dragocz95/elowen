'use client';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

/** Runtime light/dark theming. A per-device preference — it lives in localStorage, not the user
 *  record, because the right theme depends on the screen (and OS setting) in front of you. Single
 *  source of truth shared between any theme switcher and the applier: the resolved value is written
 *  to `data-theme` on the document root, and tokens.css swaps the whole palette off that attribute.
 *  Mirrors lib/useUiScale.tsx. */

const KEY = 'orca:theme';
export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';
export const DEFAULT_THEME: Theme = 'system';

function read(): Theme {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
    return DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME; // private mode / SSR
  }
}

function systemTheme(): ResolvedTheme {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'dark'; // SSR / no matchMedia — default to the app's dark baseline
  }
}

interface ThemeValue { theme: Theme; resolvedTheme: ResolvedTheme; setTheme: (t: Theme) => void }
const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME);
  const [systemResolved, setSystemResolved] = useState<ResolvedTheme>('dark');
  const [hydrated, setHydrated] = useState(false);

  // Hydrate from storage after mount (SSR-safe — server renders the default). The pre-hydration
  // script in app/layout.tsx has already painted the correct palette, so this just syncs React state.
  useEffect(() => {
    setThemeState(read());
    setSystemResolved(systemTheme());
    setHydrated(true);
  }, []);

  // Track the OS preference so `system` follows it live (e.g. macOS auto light/dark at sunset).
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemResolved(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolvedTheme: ResolvedTheme = theme === 'system' ? systemResolved : theme;

  // Keep the document root's data-theme in lockstep with the resolved value on every change —
  // but not before hydration finishes, or this would clobber the correct palette the
  // pre-hydration script already painted with the pre-hydration default ('dark') for one frame.
  useEffect(() => {
    if (!hydrated) return;
    document.documentElement.setAttribute('data-theme', resolvedTheme);
  }, [resolvedTheme, hydrated]);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    try { localStorage.setItem(KEY, t); } catch { /* quota / private mode — ignore */ }
  }, []);

  return <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
