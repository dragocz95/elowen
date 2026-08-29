'use client';
import { useCallback, useEffect, useState } from 'react';

export type DockSide = 'left' | 'right' | 'top' | 'bottom';
export type DockProfile = 'spatial' | 'command';
export interface DockState { open: boolean; side: DockSide; width: number; height: number }

const KEYS: Record<DockProfile, string> = { spatial: 'advisor:dock', command: 'advisor:dock:command' };
const DEFAULTS: Record<DockProfile, DockState> = {
  spatial: { open: false, side: 'right', width: 560, height: 420 },
  // Studio mirrors the reference workspace: the existing advisor chat is a narrow persistent right rail.
  command: { open: true, side: 'right', width: 344, height: 420 },
};
const SIDES: readonly DockSide[] = ['left', 'right', 'top', 'bottom'];
const clampWidth = (w: number, min: number) => Math.max(min, Math.min(w, (typeof window !== 'undefined' ? window.innerWidth : 1920) * 0.96));
const clampHeight = (h: number) => Math.max(240, Math.min(h, (typeof window !== 'undefined' ? window.innerHeight : 1080) * 0.85));
function read(key: string, fallback: DockState, minWidth: number): DockState {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const value = JSON.parse(raw) as Partial<DockState>;
    return {
      open: !!value.open,
      side: SIDES.includes(value.side as DockSide) ? value.side as DockSide : fallback.side,
      width: clampWidth(Number(value.width ?? fallback.width), minWidth),
      height: clampHeight(Number(value.height ?? fallback.height)),
    };
  } catch { return fallback; }
}
function write(key: string, state: DockState) { try { localStorage.setItem(key, JSON.stringify(state)); } catch { /* best effort */ } }

export function useDockState(profile: DockProfile = 'spatial') {
  const key = KEYS[profile];
  const fallback = DEFAULTS[profile];
  const minWidth = profile === 'command' ? 320 : 360;
  const [state, setState] = useState<DockState>(fallback);
  useEffect(() => { setState(read(key, fallback, minWidth)); }, [key, fallback, minWidth]);
  const update = useCallback((fn: (s: DockState) => DockState) => setState((current) => {
    const next = fn(current);
    write(key, next);
    return next;
  }), [key]);
  return {
    state,
    setOpen: useCallback((open: boolean) => update((current) => ({ ...current, open })), [update]),
    setSide: useCallback((side: DockSide) => update((current) => ({ ...current, side })), [update]),
    setWidth: useCallback((width: number) => update((current) => ({ ...current, width: clampWidth(width, minWidth) })), [update, minWidth]),
    setHeight: useCallback((height: number) => update((current) => ({ ...current, height: clampHeight(height) })), [update]),
  };
}
export type UseDockState = ReturnType<typeof useDockState>;
