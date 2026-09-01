'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'pending' | 'error';
export interface AutoSaveStatusOptions {
  ready?: boolean;
  savable?: boolean;
  delay?: number;
}
export interface AutoSaveStatusResult {
  status: SaveStatus;
  retry: () => Promise<void>;
  flush: () => Promise<SaveStatus>;
}

type SaveResult = unknown;

function activationIsPending(result: SaveResult): boolean {
  return typeof result === 'object' && result !== null && 'pending' in result && result.pending === true;
}

/**
 * Debounced auto-persist with a visible status, stale-response protection, and a flush hook — the
 * shared race-safe auto-save controller. Runs `save` shortly after any of `deps` change, but never
 * for the seed value; `ready` gates it until the form has been seeded from the server.
 *
 * `savable` is the form's current validity and is deliberately separate from `ready`. Invalid edits
 * cancel pending work and cannot be persisted through either the debounce, flush, or retry paths.
 */
export function useAutoSaveStatus(
  deps: readonly unknown[],
  save: () => Promise<SaveResult> | SaveResult,
  opts: AutoSaveStatusOptions = {},
): AutoSaveStatusResult {
  const { ready = true, savable = true, delay = 800 } = opts;
  const seeded = useRef(false);
  const saveRef = useRef(save);
  saveRef.current = save;
  const readyRef = useRef(ready);
  const savableRef = useRef(savable);
  readyRef.current = ready;
  savableRef.current = savable;

  const [status, setStatus] = useState<SaveStatus>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef(false);
  const running = useRef(false);
  const queued = useRef(false);
  const activeRun = useRef<Promise<SaveStatus> | null>(null);
  // The unmount flush deliberately leaves a save in flight after the component is gone, so its result
  // lands on a hook nobody renders any more. Reporting into that void is not just wasted work.
  const mounted = useRef(true);
  const statusRef = useRef<SaveStatus>('idle');
  const reportStatus = useCallback((next: SaveStatus) => {
    statusRef.current = next;
    if (mounted.current) setStatus(next);
  }, []);

  const run = useCallback((): Promise<SaveStatus> => {
    // Retry and flush share this guard with the debounce path. A failed valid edit must not be able to
    // write a later invalid value merely because its Retry button survived one render.
    if (!readyRef.current || !savableRef.current) {
      pending.current = false;
      return Promise.resolve(statusRef.current);
    }

    pending.current = false;
    queued.current = true;
    reportStatus('saving');
    if (running.current) return activeRun.current ?? Promise.resolve(statusRef.current);

    running.current = true;
    const operation = (async () => {
      let terminal: SaveStatus = 'saved';
      // A rapid burst never creates a request pile-up: changes made while saving collapse into one
      // queued pass, and that pass reads the latest callback/state through saveRef.
      while (queued.current) {
        queued.current = false;
        try {
          const result = await saveRef.current();
          terminal = activationIsPending(result) ? 'pending' : 'saved';
        } catch {
          terminal = 'error';
        }
      }
      running.current = false;
      reportStatus(terminal);
      return terminal;
    })();
    activeRun.current = operation;
    void operation.finally(() => {
      if (activeRun.current === operation) activeRun.current = null;
    });
    return operation;
  }, [reportStatus]);

  useEffect(() => {
    if (!ready) {
      pending.current = false;
      queued.current = false;
      return;
    }
    if (!seeded.current) { seeded.current = true; return; } // consume the seed run
    if (!savable) {
      pending.current = false;
      queued.current = false;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      return;
    }
    pending.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void run(); }, delay);
    return () => { if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, savable, run, delay, ...deps]);

  const flush = useCallback(async (): Promise<SaveStatus> => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (pending.current) return run();
    if (activeRun.current) return activeRun.current;
    return statusRef.current;
  }, [run]);

  // Flush a pending save on teardown so closing a modal never drops the last edit. The flag is cleared in
  // the same cleanup, immediately before the flush, so the write still happens while its now-invisible
  // status updates are dropped.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; void flush(); };
  }, [flush]);

  const retry = useCallback(async () => { await run(); }, [run]);
  return { status, retry, flush };
}
