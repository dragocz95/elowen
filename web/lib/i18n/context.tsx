'use client';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { dictionaries, type Locale } from './dictionaries';
import type { LocaleDict } from './types';

const STORAGE_KEY = 'orca-locale';
const DEFAULT_LOCALE: Locale = 'en';

function getInitialLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'en' || stored === 'cs') return stored;
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

export function useTranslation() {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error('useTranslation must be used within LanguageProvider');
  return ctx;
}