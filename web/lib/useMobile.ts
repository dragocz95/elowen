'use client';
import { useEffect, useState } from 'react';

/** True when the viewport matches the mobile breakpoint (≤ 767px) — mirrors the Sidebar's drawer
 *  threshold so the two never disagree on what "mobile" means. SSR-safe: starts false and hydrates
 *  in an effect, so the server and first paint agree (no hydration mismatch). */
export function useMobile(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    setMobile(mq.matches);
    const handler = (e: MediaQueryListEvent) => setMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return mobile;
}