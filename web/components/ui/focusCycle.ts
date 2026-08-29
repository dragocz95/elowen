'use client';

import { type RefObject, useEffect, useRef } from 'react';
import { hasActiveOverlay } from './overlayStack';

/** What the browser would offer Tab inside a dialog. `[tabindex="-1"]` is excluded deliberately: it is
 *  how a container makes itself focusable programmatically without joining the tab order. */
const FOCUSABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])';

/** Computed live on every Tab rather than cached on open: a dialog's controls appear, disappear and get
 *  disabled while it is on screen, and a stale list traps focus on a node that is no longer there. */
function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((node) => {
    // `tabindex="-1"` is out of the tab order whatever the element is. The selector above only says so
    // for the bare `[tabindex]` clause, so a `<button tabindex="-1">` still matched — and a listbox
    // driven by `aria-activedescendant` is made of exactly those. The cycle then believed the last
    // OPTION was the last stop, never wrapped at the real one, and Tab walked straight out of the
    // dialog the browser was skipping those options in.
    if (node.getAttribute('tabindex') === '-1') return false;
    if (node.hasAttribute('disabled') || node.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    const style = window.getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
}

/** Keep Tab inside `container`, wrapping at both ends. Call it from a `keydown` handler that has
 *  already decided this event is its own — the modal stack checks it is topmost first, a nav drawer
 *  checks it is open — and pass the element that owns the trap.
 *
 *  This is the ONE implementation of the cycle in the app: `overlayStack.ts` uses it for every modal,
 *  and `useNavDrawerFocus` below uses it for the two navigation sheets, which claim `aria-modal` and
 *  therefore owe the same promise. Focus that has escaped the container comes back on the next Tab,
 *  which is what makes the trap hold even where the background is not inert. */
export function cycleTabFocus(event: KeyboardEvent, container: HTMLElement): void {
  const items = focusableWithin(container);
  if (items.length === 0) {
    event.preventDefault();
    container.focus({ preventScroll: true });
    return;
  }
  const first = items[0]!;
  const last = items.at(-1)!;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !container.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || active === container || !container.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

/** The offcanvas navigation sheet's keyboard contract, shared by both navigations.
 *
 *  A nav drawer is deliberately NOT routed through the overlay stack (`overlayStack.ts`): it isolates the
 *  background by marking every OTHER child of `document.body` inert, which only works for an overlay
 *  portalled to the body. These drawers render inside the shell tree, so their own body-level ancestor
 *  would be the node marked inert — the sheet would disable itself. What it owes instead is what a
 *  dialog owes: focus goes in on open, Tab stays in, Escape closes, and focus returns to the opener.
 *
 *  `onClose` is read through a ref because the shell passes an unstable inline callback; as a
 *  dependency it would re-run the effect on every render and drag focus back to the first control
 *  while the reader was somewhere else in the sheet. */
export function useNavDrawerFocus({ enabled, open, containerRef, onClose }: {
  /** Whether this navigation is rendered as a drawer at all. A docked column is chrome, not a layer. */
  enabled: boolean;
  open: boolean;
  containerRef: RefObject<HTMLElement | null>;
  onClose?: () => void;
}): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const returnFocusTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container) return undefined;

    if (open) {
      returnFocusTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const requested = container.querySelector<HTMLElement>('[data-autofocus]')
        ?? container.querySelector<HTMLElement>('a[href], button');
      requested?.focus();
      const onKeyDown = (event: KeyboardEvent) => {
        // A portalled overlay sits above the drawer and owns Escape and Tab through Radix. Listen in the
        // capture phase so this decision is made before its dismissal can synchronously unregister it;
        // otherwise the same Escape bubbles on and closes both layers.
        if (hasActiveOverlay()) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          onCloseRef.current?.();
          return;
        }
        if (event.key !== 'Tab') return;
        cycleTabFocus(event, container);
      };
      window.addEventListener('keydown', onKeyDown, true);
      return () => window.removeEventListener('keydown', onKeyDown, true);
    }

    // Only take focus back if it is still inside the sheet; the user may have clicked elsewhere.
    if (container.contains(document.activeElement)) returnFocusTo.current?.focus();
    returnFocusTo.current = null;
    return undefined;
  }, [containerRef, enabled, open]);
}
