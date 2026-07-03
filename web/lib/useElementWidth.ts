'use client';
import { useState, useEffect, type RefObject } from 'react';

/** Track an element's content-box width via ResizeObserver. Returns 0 until first measured, so callers
 *  should treat 0 as "not yet known" and default to the widest layout (avoids a flash of the narrow one
 *  on first paint). Unlike a `matchMedia` on the window, this reflects the ACTUAL room a region has —
 *  which the advisor dock shrinks — so layout can react to available space, not just the viewport. */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === 'number') setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}
