'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Debounced auto-persist with a visible status, stale-response protection, and a flush hook — the
 * modal-grade successor to `useAutoSave`. Runs `save` shortly after any of `deps` change, but never
 * for the seed value; `ready` gates it until the form has been seeded from the server.
 *
 * - `status`: 'idle' | 'saving' | 'saved' | 'error' — render it in the modal footer.
 * - stale-response guard: a monotonic generation id means only the LATEST save's outcome drives the
 *   status, so a slow earlier response can't flip a newer "saved" back to an error (and vice-versa).
 *   Rapid edits are coalesced by the debounce, so at most one save is normally in flight.
 * - `flush()`: run any pending debounced save immediately (call it before closing the modal). It also
 *   runs automatically on unmount, so a change made moments before close is never silently dropped.
 * - `retry()`: re-run the save after a failure.
 *
 * Validation is preserved by the caller: make `save` a no-op (return without mutating) while the form
 * is invalid — the debounce simply won't persist until it becomes valid.
 */
export function useAutoSaveStatus(
  deps: readonly unknown[],
  save: () => Promise<void> | void,
  opts: { ready?: boolean; delay?: number } = {},
): { status: SaveStatus; retry: () => void; flush: () => void } {
  const { ready = true, delay = 800 } = opts;
  const seeded = useRef(false);
  const saveRef = useRef(save);
  saveRef.current = save;
  const [status, setStatus] = useState<SaveStatus>('idle');
  const gen = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef(false);

  const run = useCallback(() => {
    pending.current = false;
    const mine = ++gen.current; // only the newest save may set the terminal status
    setStatus('saving');
    Promise.resolve()
      .then(() => saveRef.current())
      .then(() => { if (mine === gen.current) setStatus('saved'); })
      .catch(() => { if (mine === gen.current) setStatus('error'); });
  }, []);

  useEffect(() => {
    if (!ready) return;
    if (!seeded.current) { seeded.current = true; return; } // consume the seed run
    pending.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(run, delay);
    return () => { if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, run, delay, ...deps]);

  const flush = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (pending.current) run();
  }, [run]);

  // Flush a pending save on unmount so closing the modal never drops the last edit.
  useEffect(() => () => { flush(); }, [flush]);

  const retry = useCallback(() => run(), [run]);
  return { status, retry, flush };
}
