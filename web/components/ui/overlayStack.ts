'use client';

import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from 'react';

type OverlayEntry = { id: symbol; root: HTMLElement };
type PriorState = { inert: boolean; ariaHidden: string | null };

const stack: OverlayEntry[] = [];
const priorState = new Map<HTMLElement, PriorState>();
let priorBodyOverflow = '';

/** A body-level surface that must stay LIVE over an open overlay instead of being isolated behind it.
 *
 *  The sweep below is deliberately blunt — every other child of <body> goes `inert` — because that is
 *  what makes an overlay the only thing on the page. One kind of surface has to contradict it: a toast.
 *  The stacking order already says so (`--z-toast` 130 sits above `--z-modal` 100 in tokens.css) exactly
 *  so that a message about what just happened stays readable over the thing that caused it, and a
 *  confirmation or an error raised BY a dialog is the case that band was designed for. Without an
 *  exemption the toast paints above the dialog and is unclickable and unannounced — the isolation
 *  silently winning an argument the z-scale had already settled.
 *
 *  It is an opt-in attribute rather than a list of component names here, because the stack is a generic
 *  service and should not learn what a toast is; and it is NOT a stack registration, because registering
 *  would make the toast the top of the stack and inert the dialog underneath it — a toast coexists with
 *  the overlay it appears over, it does not take over from it.
 *
 *  An exempt node is never recorded in `priorState` either, so nothing is written to it and nothing is
 *  restored onto it. Note that this only answers for THIS sweep: Radix's modal dialog runs its own
 *  `aria-hidden` pass over the same body children, and that one spares `[aria-live]`. A surface that has
 *  to survive both must carry both attributes. */
const LIVE_OVER_OVERLAYS = 'data-overlay-exempt';

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
    if (node.hasAttribute(LIVE_OVER_OVERLAYS)) continue;
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

/** Whether a body-level overlay currently owns keyboard input above shell chrome such as a nav drawer. */
export function hasActiveOverlay(): boolean {
  return stack.length > 0;
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

/** Where focus goes when an overlay closes, and nothing else.
 *
 *  Radix cannot answer this one: `Dialog` hands focus back to a `Dialog.Trigger`, and every overlay in
 *  this app is mounted on open rather than opened from a trigger, so there is nothing for it to restore
 *  to. Declining `onCloseAutoFocus` and calling this instead is what keeps the opener reachable.
 *
 *  Split out of `useOverlayIsolation` because the two halves have different prerequisites: the isolation
 *  below only works for an overlay portalled to <body>, while focus return applies to any overlay that
 *  takes focus — including the history and telemetry drawers, which render inside the shell tree and
 *  therefore cannot join the stack. */
export function useReturnFocus() {
  // Captured on the FIRST render rather than in an effect: by the time effects run, an overlay that
  // autofocuses itself has already taken focus off the control that opened it. This is also why every
  // consumer mounts on open instead of rendering itself away while closed.
  const returnFocusRef = useRef<HTMLElement | null | undefined>(undefined);
  if (returnFocusRef.current === undefined && typeof document !== 'undefined') {
    returnFocusRef.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null;
  }
  return {
    /** Focus back to the opener, if it is still on the page and still reachable. */
    restoreFocus: useCallback(() => {
      const target = returnFocusRef.current;
      if (target?.isConnected && !target.inert && !target.closest('[inert]')) target.focus({ preventScroll: true });
    }, []),
  };
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
 *  This is what every overlay in the app takes now that Radix owns its focus trap and Escape. */
export function useOverlayIsolation({ enabled, rootRef }: {
  enabled: boolean;
  rootRef: RefObject<HTMLElement | null>;
}) {
  const { restoreFocus } = useReturnFocus();
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

  // Then again once every primitive in the commit has had its say. `hideOthers()` sweeps the body from
  // a passive effect and knows only its OWN dialog: two overlays that mount in the same commit — a
  // detail rail with a dialog raised over it — leave the lower one's sweep marking the higher one
  // `aria-hidden`, which takes the live overlay out of the accessibility tree entirely. The stack is
  // what knows which one is on top, so it says so last. Writing only: `priorState` was recorded in the
  // layout pass above, so nothing Radix wrote can be mistaken for the page's own prior state.
  useEffect(() => {
    if (!enabled || !rootRef.current) return;
    syncIsolation();
  }, [enabled, rootRef]);

  return {
    /** Whether this overlay is the one the user is in — the guard every global key handler owes the stack. */
    isTopmostOverlay: useCallback(() => idRef.current != null && isTopmost(idRef.current), []),
    restoreFocus,
  };
}

