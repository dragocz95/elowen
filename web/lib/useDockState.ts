'use client';
import { useCallback, useEffect, useState } from 'react';

const KEY = 'advisor:dock';

export interface DockPane {
  id: string;
  kind: 'advisor' | 'session';
  /** Live session name — present only on `kind: 'session'` panes. */
  name?: string;
}

export type DockSide = 'left' | 'right' | 'top' | 'bottom';

export interface DockState {
  open: boolean;
  side: DockSide;
  /** Panel width in px (when docked left/right). */
  width: number;
  /** Panel height in px (when docked top/bottom). */
  height: number;
  /** Whether the advisor pane is shown. Off lets a user keep only their own terminal panes, with the
   *  advisor re-addable from the "+" menu. */
  advisor: boolean;
  /** The advisor pane (when `advisor`) plus any added session panes. */
  panes: DockPane[];
  /** flex-grow weight per pane — kept the same length as `panes`. */
  sizes: number[];
}

const ADVISOR_PANE: DockPane = { id: 'advisor', kind: 'advisor' };
const DEFAULT: DockState = { open: false, side: 'right', width: 560, height: 420, advisor: true, panes: [ADVISOR_PANE], sizes: [1] };

const clampWidth = (w: number) =>
  Math.max(360, Math.min(w, (typeof window !== 'undefined' ? window.innerWidth : 1920) * 0.96));

const clampHeight = (h: number) =>
  Math.max(240, Math.min(h, (typeof window !== 'undefined' ? window.innerHeight : 1080) * 0.85));

const SIDES: readonly DockSide[] = ['left', 'right', 'top', 'bottom'];

function read(): DockState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT;
    const p = JSON.parse(raw) as Partial<DockState>;
    // The advisor pane (when enabled) leads the stack; rebuild from the stored session panes so a
    // corrupt/legacy payload can never duplicate or misorder them. Legacy payloads have no `advisor`
    // flag → default it on so existing users keep their advisor.
    const advisor = p.advisor !== false;
    const sessionPanes = (Array.isArray(p.panes) ? p.panes : [])
      .filter((x): x is DockPane => !!x && x.kind === 'session' && typeof x.name === 'string')
      .map((x) => ({ id: x.name!, kind: 'session' as const, name: x.name! }));
    const panes = [...(advisor ? [ADVISOR_PANE] : []), ...dedupeByName(sessionPanes)];
    const storedSizes = Array.isArray(p.sizes) ? p.sizes.map(Number) : [];
    const sizes = panes.map((_, i) => (Number.isFinite(storedSizes[i]) && storedSizes[i]! > 0 ? storedSizes[i]! : 1));
    return {
      open: !!p.open,
      side: SIDES.includes(p.side as DockSide) ? (p.side as DockSide) : 'right',
      width: clampWidth(Number(p.width ?? DEFAULT.width)),
      height: clampHeight(Number(p.height ?? DEFAULT.height)),
      advisor,
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
  const setSide = useCallback((side: DockSide) => update((s) => ({ ...s, side })), [update]);
  const setWidth = useCallback((width: number) => update((s) => ({ ...s, width: clampWidth(width) })), [update]);
  const setHeight = useCallback((height: number) => update((s) => ({ ...s, height: clampHeight(height) })), [update]);
  const setSizes = useCallback((sizes: number[]) => update((s) => ({ ...s, sizes })), [update]);

  const addSessionPane = useCallback((name: string) => update((s) => {
    if (s.panes.some((p) => p.kind === 'session' && p.name === name)) return s; // idempotent
    return { ...s, panes: [...s.panes, { id: name, kind: 'session', name }], sizes: [...s.sizes, 1] };
  }), [update]);

  const removePane = useCallback((id: string) => update((s) => {
    const i = s.panes.findIndex((p) => p.id === id);
    if (i < 0) return s;
    // Removing the advisor pane just hides it (it's re-addable from "+"); a session pane is dropped.
    return {
      ...s,
      advisor: s.panes[i]!.kind === 'advisor' ? false : s.advisor,
      panes: s.panes.filter((_, idx) => idx !== i),
      sizes: s.sizes.filter((_, idx) => idx !== i),
    };
  }), [update]);

  // Bring the advisor pane back (idempotent), at the head of the stack where it belongs.
  const addAdvisorPane = useCallback(() => update((s) => {
    if (s.panes.some((p) => p.kind === 'advisor')) return s;
    return { ...s, advisor: true, panes: [ADVISOR_PANE, ...s.panes], sizes: [1, ...s.sizes] };
  }), [update]);

  return { state, setOpen, setSide, setWidth, setHeight, setSizes, addSessionPane, removePane, addAdvisorPane };
}

export type UseDockState = ReturnType<typeof useDockState>;
