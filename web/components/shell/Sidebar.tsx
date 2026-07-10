'use client';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { CircleUserRound, Settings2 } from 'lucide-react';
import { NAVIGATION_WORLDS, SYSTEM_MODULES } from '../../modules/registry';
import { useSidebarState } from '../../lib/useSidebarState';
import { useHealth, useTasks, useMe } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { NavGroup } from './NavGroup';
import { OpsStatusBar } from './OpsStatusBar';

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
  const me = useMe();
  const { t } = useTranslation();
  const dragging = useRef(false);

  const isAdmin = me.data?.user?.is_admin ?? false;
  const up = data?.ok === true;
  const working = (tasks.data ?? []).some((task) => task.status === 'in_progress');
  const status: keyof typeof DAEMON_STATUS = !up ? 'fail' : working ? 'busy' : 'ready';
  const drawer = mode === 'drawer';
  const expanded = drawer ? true : mode === 'rail' ? false : !collapsed;

  const worlds = useMemo(() => NAVIGATION_WORLDS.map((world) => ({
    id: world.id,
    href: world.route,
    label: t.nav[world.id],
    icon: world.icon,
    activeRoutes: [world.route, ...world.children.map((module) => module.route)],
    subItems: world.children.length > 0
      ? world.children.map((module) => ({
        id: module.id,
        href: module.route,
        label: t.nav[module.id as keyof typeof t.nav] ?? module.label,
        icon: module.icon,
      }))
      : undefined,
  })), [t]);

  const systemItems = useMemo(() => {
    const visibleModules = isAdmin ? SYSTEM_MODULES : [];
    return [{
      id: 'system',
      label: t.nav.system,
      icon: Settings2,
      activeRoutes: ['/account', ...visibleModules.map((module) => module.route)],
      subItems: [
        { id: 'account', href: '/account', label: t.nav.account, icon: CircleUserRound },
        ...visibleModules.map((module) => ({
          id: module.id,
          href: module.route,
          label: t.nav[module.id as keyof typeof t.nav] ?? module.label,
          icon: module.icon,
        })),
      ],
    }];
  }, [isAdmin, t]);

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
        className={drawer
          ? `fixed inset-y-0 z-50 flex h-full w-[288px] flex-col border-border bg-surface/95 shadow-2xl backdrop-blur-xl transition-transform duration-200 ${drawerPosition}`
          : `relative flex h-full shrink-0 flex-col ${side === 'right' ? 'border-l' : 'border-r'} border-border bg-surface/80 backdrop-blur-xl transition-[width] duration-200`}
        style={drawer ? { transitionTimingFunction: 'var(--ease-out)' } : { width: expanded ? width : RAIL, transitionTimingFunction: 'var(--ease-out)' }}
      >
        <div className={`flex h-16 shrink-0 items-center border-b border-border/80 ${expanded ? 'justify-between px-4' : 'justify-center px-2'}`}>
          {expanded ? (
            <img src="/elowen-logo.png" alt={t.common.appName} className="logo-adaptive h-9 w-auto max-w-[152px]" />
          ) : (
            <img src="/icon.png" alt={t.common.appName} className="h-8 w-8 rounded-lg" />
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

        <div className={`flex-1 py-2 ${expanded ? 'overflow-y-auto overflow-x-hidden' : 'overflow-visible'}`}>
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
          <OpsStatusBar expanded={expanded} />
          {expanded ? (
            <div className="px-4 pt-1 text-center font-mono text-[9px] uppercase tracking-[0.14em] text-text-muted/45">
              Elowen {data?.version ?? '—'}
            </div>
          ) : null}
        </div>

        {mode === 'full' ? (
          <button
            type="button"
            aria-label={t.common.toggleSidebar}
            onClick={toggle}
            className={`group absolute ${side === 'right' ? '-left-2.5' : '-right-2.5'} top-1/2 z-10 flex h-14 w-4 -translate-y-1/2 cursor-pointer items-center justify-center`}
          >
            <span className="h-9 w-1 rounded-full bg-border-strong transition-all duration-200 group-hover:h-12 group-hover:bg-accent/60" />
          </button>
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
