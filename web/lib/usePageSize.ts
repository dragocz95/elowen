'use client';
import { useCallback } from 'react';
import { PAGE_SIZE_OPTIONS } from '../components/ui/Pager';
import { usePersistentState } from './usePersistentState';

/** How many rows a register shows, remembered per register.
 *
 *  The choice is stored PER REGISTER rather than once for the app: "show me everything" is a statement
 *  about one table — a memory list of four thousand rows and a settings register of eleven want opposite
 *  answers — and a single shared key would make every register follow whichever one the user last
 *  touched.
 *
 *  It rides on `usePersistentState`, so it inherits the SSR-safe shape the rest of the app's remembered
 *  state has: the fallback renders on the server, the stored value arrives in an effect, and a foreign or
 *  stale value is rejected on read rather than trusted into state. The value is stored as the string
 *  localStorage would give back anyway; the parsing lives here so no call site does it twice.
 *
 *  The validator is the OFFERED list, not `Number.isFinite`. A page size is a slice bound: a stored "0"
 *  would divide a page count by zero and a stored "100000" would render the whole table at once, and
 *  neither is a value any control in the app can produce — so a key edited by hand, or left behind by a
 *  version that offered other steps, falls back instead of being honoured. */
export function usePageSize(key: string, fallback: number, options: readonly number[] = PAGE_SIZE_OPTIONS): [number, (next: number) => void] {
  const allowed = [...new Set([...options, fallback])].map(String);
  const [raw, setRaw] = usePersistentState(`elowen.pageSize.${key}`, String(fallback), allowed);
  const set = useCallback((next: number) => setRaw(String(next)), [setRaw]);
  return [Number(raw), set];
}
