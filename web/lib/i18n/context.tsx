'use client';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useBrandTheme } from '../brandContext';
import { dictionaries, type Locale } from './dictionaries';
import { interpolate } from './interpolate';
import type { LocaleDict } from './types';

const STORAGE_KEY = 'elowen-locale';
/** The locale used when nothing else is known — a first-time visitor, or a render with no stored
 *  choice. It is NOT what every first paint renders in: the choice is mirrored into a cookie the
 *  server can read, so a Czech user's document arrives in Czech instead of being painted in English
 *  and rewritten word by word once hydration reads localStorage. */
export const DEFAULT_LOCALE: Locale = 'en';

const isLocale = (value: string | null | undefined): value is Locale => !!value && value in dictionaries;

/** Mirrors the choice where the SERVER can see it. localStorage stays the client's source of truth —
 *  the cookie exists purely so the first paint is already right, which localStorage can never do. */
function writeLocaleCookie(l: Locale): void {
  // One year, path-wide, Lax: it carries a UI preference, never a credential, so it does not need to
  // be httpOnly (the client has to write it) and must not be cross-site.
  document.cookie = `${STORAGE_KEY}=${l}; path=/; max-age=31536000; samesite=lax`;
}

function readLocaleCookie(): Locale | null {
  const match = document.cookie.match(/(?:^|;\s*)elowen-locale=([^;]*)/);
  const value = match ? decodeURIComponent(match[1]) : null;
  return isLocale(value) ? value : null;
}

interface LangContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: LocaleDict;
}

const LangContext = createContext<LangContextValue | null>(null);

/** `initialLocale` is what the SERVER rendered this document in (from the cookie). Starting state must
 *  match it exactly or hydration would mismatch — and starting from anything else is what made the
 *  whole interface repaint in another language a moment after it appeared. */
export function LanguageProvider({ children, initialLocale = DEFAULT_LOCALE }: { children: ReactNode; initialLocale?: Locale }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  useEffect(() => {
    // localStorage remains the client's source of truth, so a session that predates the cookie — or one
    // whose cookie was cleared — still gets its stored choice, and writing the cookie back means the
    // NEXT document is already correct on the server. Only a genuine disagreement re-renders.
    const stored = localStorage.getItem(STORAGE_KEY);
    const resolved = isLocale(stored) ? stored : initialLocale;
    if (resolved !== initialLocale) setLocaleState(resolved);
    if (!isLocale(stored)) localStorage.setItem(STORAGE_KEY, resolved);
    if (readLocaleCookie() !== resolved) writeLocaleCookie(resolved);
    document.documentElement.lang = resolved;
  }, [initialLocale]);

  const setLocale = (l: Locale) => {
    setLocaleState(l);
    localStorage.setItem(STORAGE_KEY, l);
    writeLocaleCookie(l);
    document.documentElement.lang = l;
  };

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