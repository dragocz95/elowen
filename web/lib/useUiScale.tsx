'use client';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

/** Whole-app UI scale (CSS `zoom` on the document root) — a personal PREFERENCE and nothing else: a
 *  per-device localStorage value saying how big the user likes things, because the right size depends on
 *  the eyes and the screen in front of you. It is off (1) until someone moves the Account slider.
 *
 *  There is deliberately no automatic width-derived component. One used to multiply in underneath this
 *  one, and it was unsound rather than merely mistuned: it exempted phones and shrank everything else,
 *  which makes it discontinuous by construction — 767px rendered at 100% and 768px at 70%, flipping the
 *  app from a phone layout at full size to a desktop layout at 70% on one pixel of window travel. It was
 *  also non-monotonic below the reference width (a 1366px window got a WIDER layout viewport than a
 *  1440px one), it parked every tablet and every 1280/1366 laptop on its 0.7 floor, and by inflating the
 *  layout viewport it made `@media` and `@container` queries fire against a viewport no window ever had
 *  — so the mobile rules never reached a tablet. Fitting the design to the window is the stylesheet's
 *  job, and it is done there now. */

const KEY = 'elowen:ui-scale';
export const MIN_SCALE = 0.8;
export const MAX_SCALE = 1.5;
export const DEFAULT_SCALE = 1;

const clamp = (n: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, n));

function readPreference(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return DEFAULT_SCALE;
    const n = Number(raw);
    return Number.isFinite(n) ? clamp(n) : DEFAULT_SCALE;
  } catch {
    return DEFAULT_SCALE; // private mode / SSR
  }
}

interface UiScaleValue {
  /** The zoom actually applied to the document. */
  scale: number;
  /** The user's personal factor — what the Account slider sets. */
  preference: number;
  setPreference: (n: number) => void;
}
const UiScaleContext = createContext<UiScaleValue | null>(null);

export function UiScaleProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState(DEFAULT_SCALE);
  const scale = preference;

  // The preference hydrates after mount, so the server always renders the same neutral 1.
  useEffect(() => { setPreferenceState(readPreference()); }, []);

  // Keep the document root's zoom in lockstep with the preference. The `--ui-scale` var is published too
  // so viewport-height layout (e.g. the shell's full-height column) can divide by it: a `100dvh` box
  // under `zoom: z` renders at z×viewport, so full-height containers must size to `100dvh / z` to fill.
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('zoom', String(scale));
    root.setProperty('--ui-scale', String(scale));
  }, [scale]);

  const setPreference = useCallback((n: number) => {
    const c = clamp(n);
    setPreferenceState(c);
    try { localStorage.setItem(KEY, String(c)); } catch { /* quota / private mode — ignore */ }
  }, []);

  return <UiScaleContext.Provider value={{ scale, preference, setPreference }}>{children}</UiScaleContext.Provider>;
}

export function useUiScale(): UiScaleValue {
  const ctx = useContext(UiScaleContext);
  if (!ctx) throw new Error('useUiScale must be used within UiScaleProvider');
  return ctx;
}
