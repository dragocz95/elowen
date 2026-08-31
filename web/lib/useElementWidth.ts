'use client';
import { useCallback, useEffect, useRef, useState, type RefCallback } from 'react';

type MeasureAxis = 'width' | 'height';

/** Track one dimension of whichever DOM node currently owns a stable callback ref. React calls the ref
 * with `null` before replacing the node and then with the replacement, so the observer cannot remain
 * attached to a detached route branch. The value resets while ownership is changing instead of leaking a
 * stale desktop measurement into the next node. */
function useElementMeasure<T extends HTMLElement>(axis: MeasureAxis): [RefCallback<T>, number, boolean] {
  const [value, setValue] = useState(0);
  const [measured, setMeasured] = useState(false);
  const observerRef = useRef<ResizeObserver | null>(null);

  const ref = useCallback<RefCallback<T>>((node) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    setValue(0);
    setMeasured(false);
    if (!node || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      const next = axis === 'width' ? rect?.width : rect?.height;
      if (typeof next === 'number') {
        setValue(next);
        setMeasured(true);
      }
    });
    observerRef.current = observer;
    observer.observe(node);
  }, [axis]);

  useEffect(() => () => observerRef.current?.disconnect(), []);
  return [ref, value, measured];
}

/** Track the current element's content-box width plus whether that exact node has produced a measurement. */
export function useElementWidth<T extends HTMLElement = HTMLElement>(): [RefCallback<T>, number, boolean] {
  return useElementMeasure<T>('width');
}

/** Track the current element's content-box height plus whether that exact node has produced a measurement. */
export function useElementHeight<T extends HTMLElement = HTMLElement>(): [RefCallback<T>, number, boolean] {
  return useElementMeasure<T>('height');
}
