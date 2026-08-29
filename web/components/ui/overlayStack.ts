'use client';

import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { cycleTabFocus } from './focusCycle';

type OverlayEntry = { id: symbol; root: HTMLElement };
type PriorState = { inert: boolean; ariaHidden: string | null };

const stack: OverlayEntry[] = [];
const priorState = new Map<HTMLElement, PriorState>();
let priorBodyOverflow = '';

function syncIsolation() {
  const top = stack.at(-1)?.root ?? null;
  if (stack.length === 0) {
    for (const [node, prior] of priorState) {
      node.inert = prior.inert;
      if (prior.inert) node.setAttribute('inert', '');
      else node.removeAttribute('inert');
      if (prior.ariaHidden == null) node.removeAttribute('aria-hidden');
      else node.setAttribute('aria-hidden', prior.ariaHidden);
    }
    priorState.clear();
    document.body.style.overflow = priorBodyOverflow;
    return;
  }

  for (const node of Array.from(document.body.children)) {
    if (!(node instanceof HTMLElement)) continue;
    if (!priorState.has(node)) priorState.set(node, { inert: node.inert || node.hasAttribute('inert'), ariaHidden: node.getAttribute('aria-hidden') });
    const isolated = node !== top;
    node.inert = isolated;
    if (isolated) { node.setAttribute('inert', ''); node.setAttribute('aria-hidden', 'true'); }
    else { node.removeAttribute('inert'); node.removeAttribute('aria-hidden'); }
  }
}

function register(root: HTMLElement) {
  if (stack.length === 0) priorBodyOverflow = document.body.style.overflow;
  const entry = { id: Symbol('overlay'), root };
  stack.push(entry);
  document.body.style.overflow = 'hidden';
  syncIsolation();
  return entry.id;
}

function unregister(id: symbol) {
  const index = stack.findIndex((entry) => entry.id === id);
  if (index !== -1) stack.splice(index, 1);
  syncIsolation();
}

function isTopmost(id: symbol) {
  return stack.at(-1)?.id === id;
}

/** Isolation is applied in the COMMIT phase, ahead of every passive effect in the same commit.
 *
 *  That ordering is load-bearing now that the dialogs sit on Radix. A Radix modal `Dialog` runs
 *  `hideOthers()` from `aria-hidden` in a passive effect of its own, which marks the same set of body
 *  children `aria-hidden` that this stack does. That library deliberately leaves alone any node it finds
 *  ALREADY hidden and never clears it again, so going first makes Radix's pass a no-op and leaves one
 *  owner of the attribute. Going second would have this hook record Radix's `aria-hidden` as the page's
 *  prior state and then faithfully restore it when the last overlay closed — the whole app announced as
 *  hidden, forever. `useEffect` on the server, where a layout effect has nothing to do and React says so
 *  in the log. */
const useIsomorphicLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

/** Where an opening overlay puts focus: the control the call site asked for, else the surface itself, so
 *  the focus trap and screen readers have an anchor even when the surface has no controls yet. */
export function focusOverlaySurface(surface: HTMLElement): void {
  const requested = surface.querySelector<HTMLElement>('[data-autofocus], [autofocus]');
  (requested ?? surface).focus({ preventScroll: true });
}

/** The part of the overlay lifecycle that is THIS APP'S and has no counterpart in Radix: ownership of the
 *  overlay stack, isolation of everything below the top of it, the body scroll lock, and the element to
 *  give focus back to.
 *
 *  Radix knows none of it. It cannot: `inert` (which blocks pointers and the tab order, not just the
 *  accessibility tree) is never applied by Radix at all; the stack is what decides which of several open
 *  overlays — Radix-driven or not — is the live one; and a `Dialog` mounted without a `Dialog.Trigger`,
 *  which is every dialog in this app, leaves Radix with nothing to hand focus back to on close.
 *
 *  Use this directly when Radix already owns the focus trap and Escape (`Modal`, `ConfirmDialog`). Use
 *  `useDialogOverlay` below for a hand-written overlay that owns those itself. */
export function useOverlayIsolation({ enabled, rootRef }: {
  enabled: boolean;
  rootRef: RefObject<HTMLElement | null>;
}) {
  // Captured on the FIRST render rather than in the effect: by the time effects run, an overlay that
  // autofocuses itself has already taken focus off the control that opened it. This is also why every
  // consumer mounts on open instead of rendering itself away while closed.
  const returnFocusRef = useRef<HTMLElement | null | undefined>(undefined);
  if (returnFocusRef.current === undefined && typeof document !== 'undefined') {
    returnFocusRef.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null;
  }
  const idRef = useRef<symbol | null>(null);
  useIsomorphicLayoutEffect(() => {
    if (!enabled || !rootRef.current) return undefined;
    const id = register(rootRef.current);
    idRef.current = id;
    return () => {
      idRef.current = null;
      unregister(id);
    };
  }, [enabled, rootRef]);

  return {
    /** Whether this overlay is the one the user is in — the guard every global key handler owes the stack. */
    isTopmostOverlay: useCallback(() => idRef.current != null && isTopmost(idRef.current), []),
    /** Focus back to the opener, if it is still on the page and still reachable. */
    restoreFocus: useCallback(() => {
      const target = returnFocusRef.current;
      if (target?.isConnected && !target.inert && !target.closest('[inert]')) target.focus({ preventScroll: true });
    }, []),
  };
}

/** Shared modal/drawer lifecycle: stack ownership, background isolation, focus trap and restoration.
 *
 *  This is the whole contract for an overlay that is NOT built on a Radix primitive — the command
 *  palette, the command orbit, the workspace detail rail and the workspace takeover. `Modal` and
 *  `ConfirmDialog` take `useOverlayIsolation` instead and let Radix trap focus, because running this
 *  trap alongside Radix's would mean two implementations answering the same Tab. */
export function useDialogOverlay({ enabled, rootRef, dialogRef, onClose }: {
  enabled: boolean;
  rootRef: RefObject<HTMLElement | null>;
  dialogRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const { isTopmostOverlay, restoreFocus } = useOverlayIsolation({ enabled, rootRef });
  useEffect(() => {
    if (!enabled || !rootRef.current || !dialogRef.current) return undefined;
    const dialog = dialogRef.current;
    focusOverlaySurface(dialog);

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopmostOverlay()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      cycleTabFocus(event, dialog);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      restoreFocus();
    };
  }, [dialogRef, enabled, isTopmostOverlay, restoreFocus, rootRef]);
}
