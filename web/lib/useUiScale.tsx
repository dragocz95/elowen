'use client';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

/** Whole-app UI scale (CSS `zoom` on the document root). A per-device preference — it lives in
 *  localStorage, not the user record, because the right scale depends on the screen in front of you.
 *  Single source of truth shared between the Account slider and the global applier mounted in Shell. */

const KEY = 'orca:ui-scale';
export const MIN_SCALE = 0.8;
export const MAX_SCALE = 1.5;
export const DEFAULT_SCALE = 1;

const clamp = (n: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, n));

function read(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return DEFAULT_SCALE;
    const n = Number(raw);
    return Number.isFinite(n) ? clamp(n) : DEFAULT_SCALE;
  } catch {
    return DEFAULT_SCALE; // private mode / SSR
  }
}

interface UiScaleValue { scale: number; setScale: (n: number) => void }
const UiScaleContext = createContext<UiScaleValue | null>(null);

export function UiScaleProvider({ children }: { children: ReactNode }) {
  const [scale, setScaleState] = useState(DEFAULT_SCALE);

  // Hydrate from storage after mount (SSR-safe — server renders the default), then keep the document
  // root's zoom in lockstep with the value on every change.
  useEffect(() => { setScaleState(read()); }, []);
  useEffect(() => { document.documentElement.style.setProperty('zoom', String(scale)); }, [scale]);

  const setScale = useCallback((n: number) => {
    const c = clamp(n);
    setScaleState(c);
    try { localStorage.setItem(KEY, String(c)); } catch { /* quota / private mode — ignore */ }
  }, []);

  return <UiScaleContext.Provider value={{ scale, setScale }}>{children}</UiScaleContext.Provider>;
}

export function useUiScale(): UiScaleValue {
  const ctx = useContext(UiScaleContext);
  if (!ctx) throw new Error('useUiScale must be used within UiScaleProvider');
  return ctx;
}
