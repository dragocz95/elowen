'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/** Which inline sub-menus the reader has open.
 *
 *  Several may be open at once — that is the reference's behaviour and the reason the sub-menus are an
 *  accordion rather than a tab strip — so the state is a SET of entry ids, not one id. It is remembered
 *  per account in this browser, which is the whole storage this needs: it is a view preference of one
 *  device, not an arrangement of the menu, and the stored navigation layout (`lib/navLayout.ts`) is a
 *  server-owned document with a schema that says what a menu contains, not how it is currently folded.
 *
 *  Keyed per account for the same reason the layout cache is: on a shared machine one key means the next
 *  person to sign in inherits the previous one's folds. */
const storageKey = (userId: number) => `elowen.nav.submenus.${userId}`;

function readStored(userId: number): string[] {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    // Validated on read, not trusted: a stale or foreign value can only ever cost the folds.
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch { return []; }
}

export interface OpenSubMenus {
  isOpen: (id: string) => boolean;
  toggle: (id: string) => void;
}

/** `routeOpenId` is the sub-menu holding the page the reader just arrived at. It is OPENED on arrival
 *  rather than forced open on every render: a reader who then folds that section shut is allowed to,
 *  and a fold that springs back open under the pointer is a control that does not work. */
export function useOpenSubMenus(userId: number | null, routeOpenId?: string): OpenSubMenus {
  const [open, setOpen] = useState<readonly string[]>([]);
  // The route's fold, kept where the identity effect can read it WITHOUT depending on it. The account
  // arrives from a request and the route does not, so on a normal page load the route effect below has
  // already opened the section the reader is standing in by the time `me` resolves — and an identity
  // effect that simply assigned the stored list would close it again, on the one page where it matters.
  const routeOpenRef = useRef(routeOpenId);
  routeOpenRef.current = routeOpenId;

  useEffect(() => {
    if (userId === null) { setOpen([]); return; }
    const stored = readStored(userId);
    const forced = routeOpenRef.current;
    setOpen(forced === undefined || stored.includes(forced) ? stored : [...stored, forced]);
  }, [userId]);

  useEffect(() => {
    if (routeOpenId === undefined) return;
    setOpen((current) => (current.includes(routeOpenId) ? current : [...current, routeOpenId]));
  }, [routeOpenId]);

  const toggle = useCallback((id: string) => {
    setOpen((current) => {
      const next = current.includes(id) ? current.filter((open) => open !== id) : [...current, id];
      if (userId !== null) {
        try { localStorage.setItem(storageKey(userId), JSON.stringify(next)); } catch { /* quota / private mode */ }
      }
      return next;
    });
  }, [userId]);

  const isOpen = useCallback((id: string) => open.includes(id), [open]);
  return { isOpen, toggle };
}
