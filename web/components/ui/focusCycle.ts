'use client';

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
 *  already decided this event is its own — the modal stack checks it is topmost first — and pass the
 *  element that owns the trap.
 *
 *  This is the ONE implementation of the cycle in the app: `overlayStack.ts` uses it for every modal.
 *  Focus that has escaped the container comes back on the next Tab, which is what makes the trap hold
 *  even where the background is not inert. The navigation sheet no longer has a hand-rolled trap of its
 *  own — it is a Radix dialog now, and Radix's FocusScope owns the same promise there. */
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
