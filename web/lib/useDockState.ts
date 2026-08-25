'use client';
import { useCallback, useEffect, useState } from 'react';
const KEY = 'advisor:dock';
export type DockSide = 'left' | 'right' | 'top' | 'bottom';
export interface DockState { open: boolean; side: DockSide; width: number; height: number }
const DEFAULT: DockState = { open: false, side: 'right', width: 560, height: 420 };
const SIDES: readonly DockSide[] = ['left', 'right', 'top', 'bottom'];
const clampWidth = (w: number) => Math.max(360, Math.min(w, (typeof window !== 'undefined' ? window.innerWidth : 1920) * 0.96));
const clampHeight = (h: number) => Math.max(240, Math.min(h, (typeof window !== 'undefined' ? window.innerHeight : 1080) * 0.85));
function read(): DockState { try { const raw = localStorage.getItem(KEY); if (!raw) return DEFAULT; const v = JSON.parse(raw) as Partial<DockState>; return { open: !!v.open, side: SIDES.includes(v.side as DockSide) ? v.side as DockSide : 'right', width: clampWidth(Number(v.width ?? DEFAULT.width)), height: clampHeight(Number(v.height ?? DEFAULT.height)) }; } catch { return DEFAULT; } }
function write(state: DockState) { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* best effort */ } }
export function useDockState() {
  const [state, setState] = useState<DockState>(DEFAULT);
  useEffect(() => { setState(read()); }, []);
  const update = useCallback((fn: (s: DockState) => DockState) => setState((s) => { const next = fn(s); write(next); return next; }), []);
  return {
    state,
    setOpen: useCallback((open: boolean) => update((s) => ({ ...s, open })), [update]),
    setSide: useCallback((side: DockSide) => update((s) => ({ ...s, side })), [update]),
    setWidth: useCallback((width: number) => update((s) => ({ ...s, width: clampWidth(width) })), [update]),
    setHeight: useCallback((height: number) => update((s) => ({ ...s, height: clampHeight(height) })), [update]),
  };
}
export type UseDockState = ReturnType<typeof useDockState>;
