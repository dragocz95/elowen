'use client';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useBrandTheme } from '../brandContext';
import { dictionaries, type Locale } from './dictionaries';
import { interpolate } from './interpolate';
import type { LocaleDict } from './types';

const STORAGE_KEY = 'elowen-locale';
// The locale every FIRST paint renders in — server render and hydration alike. The stored choice is
// applied only after mount (localStorage is invisible to the server), so the server-side plugin-UI
// prefetch seeds this same locale and the post-mount switch keeps the previous listing as placeholder.
export const DEFAULT_LOCALE: Locale = 'en';

function getInitialLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && stored in dictionaries) return stored as Locale;
  return DEFAULT_LOCALE;
}

interface LangContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: LocaleDict;
}

const LangContext = createContext<LangContextValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const initial = getInitialLocale();
    setLocaleState(initial);
    document.documentElement.lang = initial;
    setMounted(true);
  }, []);

  const setLocale = (l: Locale) => {
    setLocaleState(l);
    localStorage.setItem(STORAGE_KEY, l);
    document.documentElement.lang = l;
  };

  if (!mounted) {
    return (
      <LangContext.Provider value={{ locale: DEFAULT_LOCALE, setLocale, t: dictionaries[DEFAULT_LOCALE] }}>
        {children}
      </LangContext.Provider>
    );
  }

  return (
    <LangContext.Provider value={{ locale, setLocale, t: dictionaries[locale] }}>
      {children}
    </LangContext.Provider>
  );
}

function resolveBrand<T>(value: T, values: Record<string, string>): T {
  if (typeof value === 'string') return interpolate(value, values) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveBrand(child, values)])) as T;
  }
  return value;
}

export function useTranslation() {
  const ctx = useContext(LangContext);
  const theme = useBrandTheme();
  if (!ctx) throw new Error('useTranslation must be used within LanguageProvider');
  const productName = theme.text[ctx.locale]?.appName ?? theme.brand.productName;
  const t = useMemo(
    () => resolveBrand(ctx.t, { agentName: theme.brand.agentName, productName }),
    [productName, theme.brand.agentName, ctx.t],
  );
  return { ...ctx, t };
}

/** The current locale, tolerating a missing LanguageProvider (bare component tests, isolated mounts) —
 *  brand/name resolution degrades to English instead of throwing where translations are not the point. */
export function useLocaleSafe(): Locale {
  return useContext(LangContext)?.locale ?? DEFAULT_LOCALE;
}