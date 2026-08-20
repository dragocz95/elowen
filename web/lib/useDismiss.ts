import { useEffect, useRef, type RefObject } from 'react';

/** Close a transient overlay (popover / menu / dropdown) when the user clicks or taps outside it, or
 *  presses Escape. The single hook for the app's dismissable overlays so the behaviour — and the
 *  missing-Escape drift several hand-rolled copies had — can't diverge per component. Inert while
 *  `open` is false. `onClose` is read through a ref, so passing an inline callback doesn't re-bind the
 *  listeners every render. Pass `{ escape: false }` for an overlay whose own handler owns Escape.
 *
 *  Listens on `pointerdown`, not `mousedown`: a touch or pen press only synthesizes a mouse event after
 *  the gesture completes, and never at all when the press turns into a scroll — which left a dropdown
 *  hanging open over the page while the reader scrolled it away underneath. */
export function useDismiss(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
  opts: { escape?: boolean } = {},
): void {
  const { escape = true } = opts;
  const cb = useRef(onClose);
  cb.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent): void => { if (!ref.current?.contains(e.target as Node)) cb.current(); };
    const onKey = (e: KeyboardEvent): void => { if (escape && e.key === 'Escape') cb.current(); };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, escape, ref]);
}
