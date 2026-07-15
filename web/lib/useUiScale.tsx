'use client';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

/** Whole-app UI scale (CSS `zoom` on the document root).
 *
 *  The applied zoom is two independent factors multiplied together:
 *    - an AUTOMATIC base derived from the window width, so a half-screen window stops rendering a
 *      desktop-width design at desktop density (the complaint: everything feels oversized);
 *    - a personal PREFERENCE (the Account slider) — a per-device localStorage value saying how big the
 *      user likes things *relative to normal*, because the right size depends on the eyes and the screen
 *      in front of you.
 *  Splitting them means there is no on/off mode to reason about and no dead slider: the window drives
 *  density, the slider drives taste, and the two simply compose. */

const KEY = 'elowen:ui-scale';
export const MIN_SCALE = 0.8;
export const MAX_SCALE = 1.5;
export const DEFAULT_SCALE = 1;

/** The width the interface is drawn for: at this many CSS px it renders at its reference density, and a
 *  narrower window is scaled down in proportion (a 1425px window gets 75%), so the design keeps the same
 *  relative roominess instead of cramming full-size chrome into half a screen. A wider window is left
 *  alone — nothing is ever inflated past its reference size.
 *
 *  Width is read from `window.innerWidth`, which root `zoom` does NOT scale, so the applied zoom cannot
 *  feed back into the measurement that produced it. Measuring `documentElement.clientWidth` would spiral. */
const AUTO_REFERENCE_WIDTH = 1900;
/** Past this the shrinking stops: below it the app would be small rather than merely dense. */
const AUTO_FLOOR_SCALE = 0.7;

const round = (n: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

const clamp = (n: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, n));

/** Quantised to 5% notches: dragging a window edge should re-scale in steps, not reflow the whole app on
 *  every pixel of travel. Falls back to the neutral 1 when there is no measurable window (SSR). */
export function autoScaleFor(width: number): number {
  if (!(width > 0)) return DEFAULT_SCALE;
  const fit = Math.round((width / AUTO_REFERENCE_WIDTH) * 20) / 20;
  return Math.min(DEFAULT_SCALE, Math.max(AUTO_FLOOR_SCALE, fit));
}

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
  /** The zoom actually applied to the document: `auto × preference`. */
  scale: number;
  /** The user's personal factor — what the Account slider sets. */
  preference: number;
  setPreference: (n: number) => void;
}
const UiScaleContext = createContext<UiScaleValue | null>(null);

export function UiScaleProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState(DEFAULT_SCALE);
  const [auto, setAuto] = useState(DEFAULT_SCALE);
  const scale = round(auto * preference, 4);

  // Both inputs hydrate after mount, so the server always renders the same neutral 1. Re-measuring on
  // every resize is cheap: the quantised base yields the same number for most pixels of travel, and React
  // bails out of an identical state update without re-rendering.
  useEffect(() => { setPreferenceState(readPreference()); }, []);
  useEffect(() => {
    const measure = () => setAuto(autoScaleFor(window.innerWidth));
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // Keep the document root's zoom in lockstep with the product. The `--ui-scale` var is published too so
  // viewport-height layout (e.g. the shell's full-height column) can divide by it: a `100dvh` box under
  // `zoom: z` renders at z×viewport, so full-height containers must size to `100dvh / z` to still fill.
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
