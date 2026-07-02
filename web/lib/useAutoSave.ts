'use client';
import { useEffect, useRef } from 'react';

/**
 * Debounced auto-persist: runs `save` shortly after any of `deps` change, but never for the initial
 * value (the form seed). `ready` gates the whole thing until the form has been seeded from the
 * server — the first effect run after `ready` flips is consumed silently so seeding never saves.
 */
export function useAutoSave(deps: readonly unknown[], save: () => void, opts: { ready?: boolean; delay?: number } = {}) {
  const { ready = true, delay = 800 } = opts;
  const seeded = useRef(false);
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (!ready) return;
    if (!seeded.current) { seeded.current = true; return; }
    const id = setTimeout(() => saveRef.current(), delay);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, ...deps]);
}
