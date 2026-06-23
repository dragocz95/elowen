'use client';
import { useCallback, useEffect, useState } from 'react';

const KEY = 'advisor:dock';

export interface DockPane {
  id: string;
  kind: 'advisor' | 'session';
  /** Live session name — present only on `kind: 'session'` panes. */
  name?: string;
}

export interface DockState {
  open: boolean;
  side: 'left' | 'right';
  /** Panel width in px (desktop). */
  width: number;
  /** Always holds the advisor pane plus any added session panes. */
  panes: DockPane[];
  /** flex-grow weight per pane — kept the same length as `panes`. */
  sizes: number[];
}

const ADVISOR_PANE: DockPane = { id: 'advisor', kind: 'advisor' };
const DEFAULT: DockState = { open: false, side: 'right', width: 560, panes: [ADVISOR_PANE], sizes: [1] };

const clampWidth = (w: number) =>
  Math.max(360, Math.min(w, (typeof window !== 'undefined' ? window.innerWidth : 1920) * 0.96));

function read(): DockState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT;
    const p = JSON.parse(raw) as Partial<DockState>;
    // The advisor pane is implicit and must always lead the stack; rebuild from the stored session
    // panes so a corrupt/legacy payload can never drop it or duplicate it.
    const sessionPanes = (Array.isArray(p.panes) ? p.panes : [])
      .filter((x): x is DockPane => !!x && x.kind === 'session' && typeof x.name === 'string')
      .map((x) => ({ id: x.name!, kind: 'session' as const, name: x.name! }));
    const panes = [ADVISOR_PANE, ...dedupeByName(sessionPanes)];
    const storedSizes = Array.isArray(p.sizes) ? p.sizes.map(Number) : [];
    const sizes = panes.map((_, i) => (Number.isFinite(storedSizes[i]) && storedSizes[i]! > 0 ? storedSizes[i]! : 1));
    return {
      open: !!p.open,
      side: p.side === 'left' ? 'left' : 'right',
      width: clampWidth(Number(p.width ?? DEFAULT.width)),
      panes,
      sizes,
    };
  } catch {
    // private mode / SSR / malformed payload — fall back to defaults
    return DEFAULT;
  }
}

function dedupeByName(panes: DockPane[]): DockPane[] {
  const seen = new Set<string>();
  return panes.filter((p) => (seen.has(p.name!) ? false : (seen.add(p.name!), true)));
}

function write(s: DockState) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore persistence failure */ }
}

/** Persistent layout of the docked advisor panel: open/side/width plus the vertical pane stack
 *  (advisor + added live sessions) and their flex weights. One localStorage key (`advisor:dock`). */
export function useDockState() {
  const [state, setState] = useState<DockState>(DEFAULT);
  useEffect(() => { setState(read()); }, []);

  const update = useCallback((fn: (s: DockState) => DockState) => {
    setState((s) => { const n = fn(s); write(n); return n; });
  }, []);

  const setOpen = useCallback((open: boolean) => update((s) => ({ ...s, open })), [update]);
  const setSide = useCallback((side: 'left' | 'right') => update((s) => ({ ...s, side })), [update]);
  const setWidth = useCallback((width: number) => update((s) => ({ ...s, width: clampWidth(width) })), [update]);
  const setSizes = useCallback((sizes: number[]) => update((s) => ({ ...s, sizes })), [update]);

  const addSessionPane = useCallback((name: string) => update((s) => {
    if (s.panes.some((p) => p.kind === 'session' && p.name === name)) return s; // idempotent
    return { ...s, panes: [...s.panes, { id: name, kind: 'session', name }], sizes: [...s.sizes, 1] };
  }), [update]);

  const removePane = useCallback((id: string) => update((s) => {
    const i = s.panes.findIndex((p) => p.id === id);
    if (i < 0 || s.panes[i]!.kind === 'advisor') return s; // the advisor pane is permanent
    return {
      ...s,
      panes: s.panes.filter((_, idx) => idx !== i),
      sizes: s.sizes.filter((_, idx) => idx !== i),
    };
  }), [update]);

  return { state, setOpen, setSide, setWidth, setSizes, addSessionPane, removePane };
}

export type UseDockState = ReturnType<typeof useDockState>;
