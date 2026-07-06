'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ChevronRight, type LucideIcon } from 'lucide-react';

interface NavSubEntry { id: string; href: string; label: string }
export interface NavEntry { href: string; label: string; icon: LucideIcon; badge?: number; subItems?: NavSubEntry[] }

/** A same-page section sub-item (e.g. /settings?cat=x) is a query-only change on the current pathname.
 *  Next's <Link> does NOT re-render a statically optimized route on such a nav, so drive it ourselves:
 *  push the URL and fire a popstate so the page (and this nav's highlight) react. A cross-pathname
 *  sub-item falls through to Next's normal navigation. */
function switchSamePageSection(href: string): boolean {
  if (typeof window === 'undefined') return false;
  if (href.split('?')[0] !== window.location.pathname) return false;
  window.history.pushState(null, '', href);
  window.dispatchEvent(new PopStateEvent('popstate'));
  return true;
}

export function NavItem({ entry, active, collapsed }: { entry: NavEntry; active: boolean; collapsed: boolean }) {
  const Icon = entry.icon;
  const badge = entry.badge && entry.badge > 0 ? entry.badge : 0;
  const searchParams = useSearchParams();
  const hasSub = !collapsed && !!entry.subItems?.length;
  // Sub-items follow the active state by default (the settings tree opens when you're in Settings), but
  // the chevron lets the user override it either way. `null` = follow `active`.
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = hasSub && (manualOpen ?? active);
  // Track `?cat=` from the ACTUAL URL and follow popstate (our same-page switches + browser back/forward),
  // since useSearchParams is stale on the statically optimized settings route. Falls back to it pre-mount.
  const [popCat, setPopCat] = useState<string | null>(null);
  useEffect(() => {
    const read = () => setPopCat(new URLSearchParams(window.location.search).get('cat'));
    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);
  const currentCat = popCat ?? searchParams.get('cat');

  return (
    <>
      <div className="relative flex items-center">
        <Link
          href={entry.href}
          title={collapsed ? entry.label : undefined}
          aria-current={active ? 'page' : undefined}
          className={`relative flex flex-1 items-center gap-3 border-l-2 px-3 py-2 text-sm transition-colors ${active ? 'border-accent text-text' : 'border-transparent text-text-muted hover:text-text'}${collapsed ? ' justify-center' : ''}`.trim()}
        >
          <span className="relative shrink-0">
            <Icon size={16} strokeWidth={1.5} aria-hidden />
            {badge > 0 && collapsed && (
              <span className="absolute -right-1.5 -top-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-warning px-0.5 text-[9px] font-bold text-black">{badge}</span>
            )}
          </span>
          {!collapsed && <span className="text-sm tracking-normal">{entry.label}</span>}
          {badge > 0 && !collapsed && !hasSub && (
            <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-warning/15 px-1 text-[10px] font-bold text-warning">{badge}</span>
          )}
        </Link>
        {hasSub && (
          <button
            type="button"
            aria-label={open ? 'Sbalit' : 'Rozbalit'}
            aria-expanded={open}
            onClick={() => setManualOpen(!open)}
            className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-muted transition-colors hover:bg-elevated hover:text-text"
          >
            <ChevronRight size={14} className={`transition-transform duration-200 ${open ? 'rotate-90' : ''}`} aria-hidden />
          </button>
        )}
      </div>
      {open && entry.subItems && (
        <div className="flex flex-col py-0.5">
          {entry.subItems.map((sub, i) => {
            const on = active && (currentCat === sub.id || (!currentCat && i === 0));
            return (
              <Link
                key={sub.id}
                href={sub.href}
                onClick={(e) => { if (switchSamePageSection(sub.href)) e.preventDefault(); }}
                aria-current={on ? 'page' : undefined}
                className={`flex items-center border-l-2 py-1.5 pl-11 pr-3 text-[13px] transition-colors ${on ? 'border-accent/60 text-text' : 'border-transparent text-text-muted hover:text-text'}`}
              >
                {sub.label}
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
