'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Debounced auto-persist with a visible status, stale-response protection, and a flush hook — the
 * Shared race-safe auto-save controller. Runs `save` shortly after any of `deps` change, but never
 * for the seed value; `ready` gates it until the form has been seeded from the server.
 *
 * - `status`: 'idle' | 'saving' | 'saved' | 'error' — render it in the modal footer.
 * - serialized writes: when another edit lands during an in-flight request, exactly one follow-up
 *   write with the latest form state runs after it. This prevents an older request from finishing
 *   last and overwriting a newer value on the server.
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
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef(false);
  const running = useRef(false);
  const queued = useRef(false);

  const run = useCallback(() => {
    pending.current = false;
    queued.current = true;
    setStatus('saving');
    if (running.current) return;

    running.current = true;
    void (async () => {
      let terminal: SaveStatus = 'saved';
      // A rapid burst never creates a request pile-up: changes made while saving collapse into one
      // queued pass, and that pass reads the latest callback/state through saveRef.
      while (queued.current) {
        queued.current = false;
        try {
          await saveRef.current();
          terminal = 'saved';
        } catch {
          terminal = 'error';
        }
      }
      running.current = false;
      setStatus(terminal);
    })();
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
