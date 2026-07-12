'use client';

import { type RefObject, useEffect, useRef } from 'react';

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

const FOCUSABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])';

function focusableWithin(dialog: HTMLElement) {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((node) => {
    if (node.hasAttribute('disabled') || node.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    const style = window.getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
}

/** Shared modal/drawer lifecycle: stack ownership, background isolation, focus trap and restoration. */
export function useDialogOverlay({ enabled, rootRef, dialogRef, onClose }: {
  enabled: boolean;
  rootRef: RefObject<HTMLElement | null>;
  dialogRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const returnFocusRef = useRef<HTMLElement | null | undefined>(undefined);
  if (returnFocusRef.current === undefined && typeof document !== 'undefined') {
    returnFocusRef.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null;
  }
  useEffect(() => {
    if (!enabled || !rootRef.current || !dialogRef.current) return;
    const root = rootRef.current;
    const dialog = dialogRef.current;
    const id = register(root);
    const requested = dialog.querySelector<HTMLElement>('[data-autofocus], [autofocus]');
    (requested ?? dialog).focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopmost(id)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusableWithin(dialog);
      if (items.length === 0) { event.preventDefault(); dialog.focus({ preventScroll: true }); return; }
      const first = items[0]!;
      const last = items.at(-1)!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (active === last || active === dialog || !dialog.contains(active))) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      unregister(id);
      const returnTarget = returnFocusRef.current;
      if (returnTarget?.isConnected && !returnTarget.inert && !returnTarget.closest('[inert]')) returnTarget.focus({ preventScroll: true });
    };
  }, [dialogRef, enabled, rootRef]);
}
