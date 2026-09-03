'use client';
import { useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { ROW_ANCHOR_PARAM, ROW_FLASH_CLASS } from './rowAnchors';

/** ARRIVING ON A ROW. A page that reads `?cat=<section>` also reads `?row=<rowId>`: once the section is
 *  on screen, the row carrying that anchor (`data-row-id`, see `SettingsRow`) is scrolled into view and
 *  blinked once, the way a documentation site reveals the heading a link named.
 *
 *  THE URL IS THE ONLY CHANNEL. The palette merely pushes a richer href, so a semantic suggestion, an
 *  "Ask AI" answer, a shared link and a browser back all arrive through the same door. The three paths
 *  `cat` already needs are the three this needs: the first load / F5 (read from `window.location`,
 *  because a statically optimized route answers `useSearchParams` empty until a client navigation), the
 *  client navigation (`useSearchParams`, which is also what makes a push from the page the user is
 *  ALREADY on re-run this) and `popstate`.
 *
 *  THE ANCHOR IS CONSUMED. It is stripped from the URL with `replaceState` as soon as it has been acted
 *  on, so reloading the page does not blink the row again — and so the next push of the same link is a
 *  change of the URL again rather than a no-op.
 *
 *  A SECTION MOUNTS LAZILY, so the row may not exist yet when the URL says it should. The wait is a
 *  MutationObserver bounded to {@link ROW_WAIT_MS} — never a polling loop — and it ends quietly: a link
 *  to a row that has since been renamed or removed simply opens the section, with no error and no
 *  scroll. */

/** How long a not-yet-mounted row is waited for. Long enough for a section whose data arrives over the
 *  network, short enough that a stale anchor cannot leave an observer attached to the document. */
const ROW_WAIT_MS = 2000;
/** Backstop for removing the highlight class when no `animationend` arrives — quiet effects and reduced
 *  motion replace the animation with a static outline, and then this timer is what clears it. Longer
 *  than the 1.6 s keyframes in `app/styles/animations.css`. */
const ROW_FLASH_MS = 1800;

export function useRowAnchor(): void {
  const searchParams = useSearchParams();
  const urlRow = searchParams.get(ROW_ANCHOR_PARAM);
  /** Stops the bounded wait for a row that has not mounted yet. */
  const cancelWait = useRef<(() => void) | null>(null);
  /** Ends the highlight currently on screen, whether it finished or not. */
  const endFlash = useRef<(() => void) | null>(null);

  const reveal = useCallback((row: HTMLElement) => {
    // A second arrival while the first is still blinking: clear the old class before adding it again,
    // otherwise the animation would never restart.
    endFlash.current?.();
    row.scrollIntoView({ block: 'center' });
    // Focus is deliberately NOT moved. The palette hands focus back to whatever opened it, and a row
    // that happens to contain a switch would otherwise swallow the next keystroke. A blink is not a
    // focus: it says "here", it does not take over.
    row.classList.add(ROW_FLASH_CLASS);
    let timer = 0;
    const clear = () => {
      row.classList.remove(ROW_FLASH_CLASS);
      row.removeEventListener('animationend', clear);
      window.clearTimeout(timer);
      endFlash.current = null;
    };
    row.addEventListener('animationend', clear);
    timer = window.setTimeout(clear, ROW_FLASH_MS);
    endFlash.current = clear;
  }, []);

  const apply = useCallback(() => {
    const rowId = new URLSearchParams(window.location.search).get(ROW_ANCHOR_PARAM);
    if (!rowId) return;
    cancelWait.current?.();
    cancelWait.current = null;
    // The id arrives from the URL, so the two characters that could break out of a quoted attribute
    // selector are escaped rather than trusted. Every real anchor is a dictionary path.
    const selector = `[data-row-id="${rowId.replace(/["\\]/g, '\\$&')}"]`;
    const find = (): HTMLElement | null => document.body.querySelector<HTMLElement>(selector);
    const settle = (row: HTMLElement | null) => {
      cancelWait.current?.();
      cancelWait.current = null;
      if (row) reveal(row);
      // Stripped even when nothing was found: the anchor has been answered as well as it can be, and
      // leaving it in the URL would retry the whole search on the next render.
      const url = new URL(window.location.href);
      url.searchParams.delete(ROW_ANCHOR_PARAM);
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    };
    const mounted = find();
    if (mounted) {
      settle(mounted);
      return;
    }
    const observer = new MutationObserver(() => {
      const row = find();
      if (row) settle(row);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timeout = window.setTimeout(() => settle(null), ROW_WAIT_MS);
    cancelWait.current = () => { observer.disconnect(); window.clearTimeout(timeout); };
  }, [reveal]);

  // First load and every client navigation: `urlRow` is the render-visible copy of the parameter, and
  // `apply` re-reads the live URL, which is the authoritative one on a statically optimized route.
  useEffect(() => { apply(); }, [apply, urlRow]);

  useEffect(() => {
    window.addEventListener('popstate', apply);
    return () => window.removeEventListener('popstate', apply);
  }, [apply]);

  useEffect(() => () => { cancelWait.current?.(); endFlash.current?.(); }, []);
}
