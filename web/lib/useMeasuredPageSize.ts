'use client';
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** The page is sized to the surface instead of being a fixed count. A register lives in a FIXED-height
 *  modal, so a hard-coded twelve rows leaves a dead band under the table on a large screen while still
 *  overflowing a short one — the table stops where the dialog keeps going.
 *
 *  Only the VIEWPORT is measured, never the content: the scroll box takes its height from flex, so how
 *  many rows are shown cannot feed back into how much room there is and the observer cannot oscillate.
 *  Where nothing can be measured (a zero-height box, jsdom) the fallback stands. */
const FALLBACK_PAGE_SIZE = 12;
const MIN_PAGE_SIZE = 4;
const FALLBACK_ROW_HEIGHT = 44;

/** How many rows fit the scroll box, and the page that keeps the reader where they were across a resize.
 *
 *  The header row is inside the scroll box, so it eats from the same budget; both heights are read off
 *  the live DOM, which keeps this honest when density, font size or zoom changes. The row measured is a
 *  ROOT (`data-tree-row="root"`), because a page counts roots: a nested sub-agent or a job link is
 *  shorter and denser, and measuring one would claim more conversations fit than actually do. */
export function useMeasuredPageSize(scrollRef: RefObject<HTMLDivElement | null>): {
  pageSize: number;
  page: number;
  setPage: (next: number | ((current: number) => number)) => void;
} {
  const [pageSize, setPageSize] = useState(FALLBACK_PAGE_SIZE);
  const [page, setPage] = useState(0);
  // The measurement's own view of the current size: the observer must compare against the latest value
  // without re-subscribing, and reading it out of state would pin the callback to a stale render.
  const pageSizeRef = useRef(FALLBACK_PAGE_SIZE);

  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => {
      const available = box.clientHeight;
      if (available <= 0) return; // hidden or unmeasurable — keep the last good answer rather than guessing
      const rows = box.querySelectorAll('[role="row"]');
      const headHeight = rows[0]?.getBoundingClientRect().height ?? 0;
      const rowHeight = box.querySelector('[data-tree-row="root"]')?.getBoundingClientRect().height ?? FALLBACK_ROW_HEIGHT;
      if (rowHeight <= 0) return;
      const next = Math.max(MIN_PAGE_SIZE, Math.floor((available - headHeight) / rowHeight));
      const prev = pageSizeRef.current;
      if (prev === next) return;
      pageSizeRef.current = next;
      setPageSize(next);
      setPage((p) => Math.floor((p * prev) / next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [scrollRef]);

  return { pageSize, page, setPage };
}
