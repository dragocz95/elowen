'use client';
import { useState, useEffect, type RefObject } from 'react';
import { uiZoom } from './uiZoom';

/** The height that makes an element reach the bottom of the window: the viewport, less the element's own
 *  top offset, less every bottom padding between it and the scroll container it sits in.
 *
 *  Those gutters are READ from the layout rather than restated as a constant here. The page's padding
 *  stays defined in exactly one place — its CSS — and changing it there cannot silently push the element
 *  back past the fold and bring the page scrollbar with it.
 *
 *  Geometry under the shell's root zoom comes back in visual px, not CSS px (see uiZoom), so the measured
 *  terms are divided by it; computed paddings are already CSS px and are not. Returns undefined until
 *  measured, so the server renders whatever fallback height the stylesheet gives. */
export function useFillHeight(ref: RefObject<HTMLElement | null>, minPx = 320): number | undefined {
  const [height, setHeight] = useState<number | undefined>(undefined);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const scroller = el.closest('main') ?? document.documentElement;

    const measure = () => {
      const zoom = uiZoom();
      let gutter = parseFloat(getComputedStyle(scroller).paddingBottom) || 0;
      for (let node = el.parentElement; node && node !== scroller; node = node.parentElement) {
        gutter += parseFloat(getComputedStyle(node).paddingBottom) || 0;
      }
      // A bounding rect is viewport-relative. Once the page has scrolled, using it directly makes the
      // measured top negative and inflates the fill height by the current scroll offset. Phone browsers
      // resize the visual viewport as their chrome hides/shows, so one resize near the bottom could freeze
      // thousands of pixels of empty flex space under the transcript. Convert the visual position back to
      // the element's stable position inside the scroller before deriving the remaining viewport height.
      const top = (el.getBoundingClientRect().top - scroller.getBoundingClientRect().top) / zoom + scroller.scrollTop;
      setHeight(Math.max(minPx, Math.round(window.innerHeight / zoom - top - gutter)));
    };

    measure();
    // Re-measure on anything that can move the element: the window resizing, the advisor dock opening,
    // a header wrapping onto a second line. Watching the scroll container catches all of them.
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(scroller);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [ref, minPx]);

  return height;
}
