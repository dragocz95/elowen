'use client';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef } from 'react';
import { useSidebarState } from '../../lib/useSidebarState';
import { useHealth, useTasks } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { useBrand } from '../../lib/brand';
import { NavGroup } from './NavGroup';
import { CollapseHandle } from './CollapseHandle';
import { useShellNavigation } from './useShellNavigation';

const RAIL = 68;
const DAEMON_STATUS = {
  ready: { color: 'var(--color-success)', ring: 'color-mix(in srgb, var(--color-success) 50%, transparent)' },
  busy: { color: 'var(--color-warning)', ring: 'color-mix(in srgb, var(--color-warning) 50%, transparent)' },
  fail: { color: 'var(--color-error)', ring: 'color-mix(in srgb, var(--color-error) 50%, transparent)' },
} as const;

/** How the sidebar presents itself, decided by the shell from the measured room it has. */
export type SidebarMode = 'full' | 'rail' | 'drawer';

export function Sidebar({
  mode = 'full',
  drawerOpen = false,
  onDrawerClose,
  side = 'left',
}: {
  mode?: SidebarMode;
  drawerOpen?: boolean;
  onDrawerClose?: () => void;
  side?: 'left' | 'right';
}) {
  const pathname = usePathname();
  const { collapsed, width, toggle, setWidth } = useSidebarState();
  const { data } = useHealth();
  const tasks = useTasks();
  const { t } = useTranslation();
  const brand = useBrand();
  const { worlds, systemItems } = useShellNavigation();
  const dragging = useRef(false);

  const up = data?.ok === true;
  const working = (tasks.data ?? []).some((task) => task.status === 'in_progress');
  const status: keyof typeof DAEMON_STATUS = !up ? 'fail' : working ? 'busy' : 'ready';
  const drawer = mode === 'drawer';
  const expanded = drawer ? true : mode === 'rail' ? false : !collapsed;

  // Route changes are the only automatic drawer-close signal; the callback itself is an unstable
  // inline prop from Shell, so intentionally keep it out of this dependency list.
  useEffect(() => { if (drawer) onDrawerClose?.(); }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    dragging.current = true;
    (event.target as Element).setPointerCapture?.(event.pointerId);
  }, []);
  const onPointerMove = useCallback((event: React.PointerEvent) => {
    if (dragging.current) setWidth(side === 'right' ? window.innerWidth - event.clientX : event.clientX);
  }, [setWidth, side]);
  const onPointerUp = useCallback((event: React.PointerEvent) => {
    dragging.current = false;
    (event.target as Element).releasePointerCapture?.(event.pointerId);
  }, []);

  const drawerPosition = side === 'right'
    ? `right-0 border-l ${drawerOpen ? 'translate-x-0' : 'translate-x-full'}`
    : `left-0 border-r ${drawerOpen ? 'translate-x-0' : '-translate-x-full'}`;

  return (
    <>
      {drawer ? (
        <div
          aria-hidden
          onClick={onDrawerClose}
          className={`fixed inset-0 z-40 bg-black/70 backdrop-blur-[2px] transition-opacity ${drawerOpen ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
        />
      ) : null}

      <nav
        aria-label={t.common.primaryNav}
        aria-hidden={drawer && !drawerOpen ? true : undefined}
        inert={drawer && !drawerOpen ? true : undefined}
        className={drawer
          ? `fixed inset-y-0 z-50 flex h-full w-[288px] flex-col border-border bg-surface/95 shadow-2xl backdrop-blur-xl transition-transform duration-200 ${drawerPosition}`
          : `relative flex h-full shrink-0 flex-col ${side === 'right' ? 'border-l' : 'border-r'} border-border bg-surface/80 backdrop-blur-xl transition-[width] duration-200`}
        style={drawer ? { transitionTimingFunction: 'var(--ease-out)' } : { width: expanded ? width : RAIL, transitionTimingFunction: 'var(--ease-out)' }}
      >
        <div className={`flex h-16 shrink-0 items-center border-b border-border/80 ${expanded ? 'justify-between px-4' : 'justify-center px-2'}`}>
          {expanded ? (
            <img src={brand.logoSrc} alt={brand.appName} className="logo-adaptive h-9 w-auto max-w-[152px]" />
          ) : (
            <img src={brand.iconSrc} alt={brand.appName} className="h-8 w-8 rounded-lg" />
          )}
          {expanded ? (
            <span
              role="status"
              aria-label={up ? t.common.daemonUp : t.common.daemonDown}
              title={status === 'fail' ? t.common.daemonOffline : status === 'busy' ? t.common.daemonBusy : t.common.daemonReady}
              className={`h-2.5 w-2.5 rounded-full ${up ? 'live-dot' : ''}`}
              style={{ backgroundColor: DAEMON_STATUS[status].color, ['--live-ring' as string]: DAEMON_STATUS[status].ring }}
            />
          ) : null}
        </div>

        <div className={`relative z-30 flex-1 py-4 ${expanded ? 'overflow-y-auto overflow-x-hidden scroll-pt-4' : 'overflow-visible'}`}>
          <NavGroup
            group={{ label: t.nav.worlds, items: worlds }}
            pathname={pathname}
            collapsed={!expanded}
            forceSubItems={drawer}
            side={side}
            expandLabel={t.common.expand}
            collapseLabel={t.common.collapse}
          />
          <div className="mt-3 border-t border-border/60 pt-2">
            <NavGroup
              group={{ label: t.nav.system, items: systemItems }}
              pathname={pathname}
              collapsed={!expanded}
              forceSubItems={drawer}
              side={side}
              expandLabel={t.common.expand}
              collapseLabel={t.common.collapse}
            />
          </div>
        </div>

        <div className="shrink-0 border-t border-border/80 bg-bg/20">
          {expanded ? (
            <div className="px-4 py-3 text-center font-mono text-[9px] uppercase tracking-[0.14em] text-text-muted/45">
              Elowen {data?.version ?? '—'}
            </div>
          ) : null}
        </div>

        {mode === 'full' ? (
          <CollapseHandle side={side} label={t.common.toggleSidebar} onToggle={toggle} />
        ) : null}

        {!drawer && expanded ? (
          <div
            data-testid="sidebar-resize"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onDoubleClick={() => setWidth(224)}
            className={`absolute ${side === 'right' ? 'left-0' : 'right-0'} top-0 h-full w-1 cursor-col-resize`}
          />
        ) : null}
      </nav>
    </>
  );
}
