'use client';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Languages } from 'lucide-react';
import { modulesByGroup } from '../../modules/registry';
import { useSidebarState } from '../../lib/useSidebarState';
import { useHealth } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { NavGroup } from './NavGroup';

const RAIL = 56;

export function Sidebar() {
  const pathname = usePathname();
  const { collapsed, width, toggle, setWidth } = useSidebarState();
  const { data } = useHealth();
  const up = data?.ok === true;
  const dragging = useRef(false);

  const { t, locale, setLocale } = useTranslation();

  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    setMobile(mq.matches);
    const handler = (e: MediaQueryListEvent) => setMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Collapsed stays collapsed (icon rail) until the user toggles it — no hover auto-open.
  const pinnedCollapsed = collapsed || mobile;
  const expanded = !pinnedCollapsed;

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }, []);
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (dragging.current) setWidth(e.clientX);
  }, [setWidth]);
  const onPointerUp = useCallback((e: React.PointerEvent) => {
    dragging.current = false;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  }, []);

  return (
    <nav
      aria-label={t.common.primaryNav}
      className="relative flex h-full shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-200"
      style={{ width: expanded ? width : RAIL, transitionTimingFunction: 'var(--ease-out)' }}
    >
      <div className="flex items-center justify-center border-b border-border px-3 py-3 overflow-hidden">
        {expanded
          ? <img src="/orca-logo.png" alt={t.common.appName} className="h-9 w-auto" />
          : <img src="/icon.png" alt={t.common.appName} className="h-7 w-7 rounded-md" />}
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {modulesByGroup().map((g) => {
          const groupLabel = g.group === 'Operate' ? t.nav.operate : t.nav.config;
          return (
            <NavGroup
              key={g.group}
              group={{
                label: groupLabel,
                items: g.items.map((m) => ({
                  href: m.route,
                  label: t.nav[m.id as keyof typeof t.nav] ?? m.label,
                  icon: m.icon,
                })),
              }}
              pathname={pathname}
              collapsed={!expanded}
            />
          );
        })}
      </div>

      <div className="flex items-center gap-2 border-t border-border px-4 py-3">
        <span role="status" aria-label={up ? t.common.daemonUp : t.common.daemonDown} className="flex items-center justify-center">
          <span
            className={`h-2 w-2 rounded-full ${up ? 'live-dot bg-accent' : 'bg-text-muted'}`}
            style={up ? ({ ['--live-ring' as string]: 'rgba(59,130,246,0.5)' }) : undefined}
            aria-hidden
          />
        </span>
        {expanded && <span className="font-mono text-[10px] uppercase tracking-wide text-text-muted">{t.common.daemon}</span>}
        {expanded && (
          <button
            type="button"
            onClick={() => setLocale(locale === 'en' ? 'cs' : 'en')}
            className="ml-auto flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] font-mono uppercase tracking-wide text-text-muted transition-colors hover:border-border-strong hover:text-text"
            aria-label={t.common.switchLang}
          >
            <Languages size={12} aria-hidden />
            {locale === 'en' ? 'CS' : 'EN'}
          </button>
        )}
      </div>

      {/* Pill handle toggle (pins collapsed/expanded) — no arrow, alex-parts style */}
      <button
        type="button"
        aria-label={t.common.toggleSidebar}
        onClick={toggle}
        className="group absolute -right-2 top-1/2 z-10 flex h-14 w-4 -translate-y-1/2 items-center justify-center"
      >
        <span className="h-9 w-1 rounded-full bg-border transition-all duration-200 group-hover:h-12 group-hover:bg-text-muted" />
      </button>

      {expanded && !pinnedCollapsed && (
        <div
          data-testid="sidebar-resize"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDoubleClick={() => setWidth(224)}
          className="absolute right-0 top-0 h-full w-1 cursor-col-resize"
        />
      )}
    </nav>
  );
}
