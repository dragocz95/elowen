'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef } from 'react';
import { User, ShieldAlert } from 'lucide-react';
import { modulesByGroup } from '../../modules/registry';
import { useSidebarState } from '../../lib/useSidebarState';
import { useHealth, useTasks, useMe, useEscalations, usePendingAsks } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { NavGroup } from './NavGroup';
import { OpsStatusBar } from './OpsStatusBar';
import { NotificationBell } from '../ui/NotificationBell';
import { Avatar } from '../ui/Avatar';
import { ThemeToggle } from '../ui/ThemeToggle';
import { LanguageSwitcher } from '../ui/LanguageSwitcher';

const RAIL = 56;
const DAEMON_STATUS = {
  ready: { color: 'var(--color-success)', ring: 'color-mix(in srgb, var(--color-success) 50%, transparent)' },
  busy: { color: 'var(--color-warning)', ring: 'color-mix(in srgb, var(--color-warning) 50%, transparent)' },
  fail: { color: 'var(--color-error)', ring: 'color-mix(in srgb, var(--color-error) 50%, transparent)' },
} as const;

/** How the sidebar presents itself, decided by the shell from the MEASURED room it has (not the
 *  viewport): `full` = user's pin decides expanded/rail · `rail` = forced icon rail (space is tight) ·
 *  `drawer` = off-canvas hamburger drawer (very tight / phones). */
export type SidebarMode = 'full' | 'rail' | 'drawer';

export function Sidebar({ mode = 'full', drawerOpen = false, onDrawerClose, side = 'left' }: { mode?: SidebarMode; drawerOpen?: boolean; onDrawerClose?: () => void; side?: 'left' | 'right' }) {
  const pathname = usePathname();
  const { collapsed, width, toggle, setWidth } = useSidebarState();
  const { data } = useHealth();
  const tasks = useTasks();
  const me = useMe();
  const isAdmin = me.data?.user?.is_admin ?? false;
  const up = data?.ok === true;
  // ready = up & idle · busy = up & a task is actually in progress · fail = unreachable
  const working = (tasks.data ?? []).some((t) => t.status === 'in_progress');
  const status: keyof typeof DAEMON_STATUS = !up ? 'fail' : working ? 'busy' : 'ready';
  const nextReady = (tasks.data ?? []).find((t) => t.status === 'open' && t.type !== 'epic');
  const escalations = useEscalations();
  // Agent questions parked on a human count as escalations for the badge — an agent is blocked on each.
  const pendingAsks = usePendingAsks().data ?? [];
  const escalationCount = escalations.length + pendingAsks.length;
  const dragging = useRef(false);

  const { t } = useTranslation();

  const drawer = mode === 'drawer';
  // Drawer shows full content; a forced rail (tight space) collapses; otherwise the user's pin decides.
  const expanded = drawer ? true : mode === 'rail' ? false : !collapsed;

  // Close the drawer after navigating. Keyed on `pathname` ALONE on purpose: `onDrawerClose` is a fresh
  // inline arrow each render, so listing it would fire this on every parent re-render (closing the
  // drawer spuriously); `drawer` is read at run time. Only a route change should close it.
  useEffect(() => { if (drawer) onDrawerClose?.(); }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }, []);
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    // When the rail sits on the right edge, width grows as the cursor moves left, so measure from the
    // viewport's right edge instead of from x=0.
    if (dragging.current) setWidth(side === 'right' ? window.innerWidth - e.clientX : e.clientX);
  }, [setWidth, side]);
  const onPointerUp = useCallback((e: React.PointerEvent) => {
    dragging.current = false;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  }, []);

  return (
    <>
      {drawer && (
        <div
          aria-hidden
          onClick={onDrawerClose}
          className={`fixed inset-0 z-40 bg-black/50 transition-opacity ${drawerOpen ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
        />
      )}
    <nav
      aria-label={t.common.primaryNav}
      className={drawer
        ? `fixed inset-y-0 left-0 z-50 flex h-full w-[264px] flex-col overflow-hidden border-r border-border bg-surface transition-transform duration-200 ${drawerOpen ? 'translate-x-0' : '-translate-x-full'}`
        : `relative flex h-full shrink-0 flex-col ${side === 'right' ? 'border-l' : 'border-r'} border-border bg-surface transition-[width] duration-200`}
      style={drawer ? { transitionTimingFunction: 'var(--ease-out)' } : { width: expanded ? width : RAIL, transitionTimingFunction: 'var(--ease-out)' }}
    >
      <div className="flex h-14 items-center justify-center border-b border-border px-3 overflow-hidden">
        {expanded
          ? <img src="/orca-logo.png" alt={t.common.appName} className="logo-adaptive h-9 w-auto" />
          : <img src="/icon.png" alt={t.common.appName} className="h-7 w-7 rounded-md" />}
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {modulesByGroup().filter((g) => g.group !== 'Config' || isAdmin).map((g) => {
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
                  badge: m.id === 'escalations' ? escalationCount : undefined,
                })),
              }}
              pathname={pathname}
              collapsed={!expanded}
            />
          );
        })}
      </div>

      {/* Escalations alert — sits above "next ready" so a rejected phase waiting on a human is the
          first thing you see. Warning-toned, shows the count and the latest rejected phase. */}
      {expanded && escalationCount > 0 && (() => {
        const topTitle = escalations[0]?.title ?? pendingAsks[0]?.title ?? t.escalations.askTitle;
        return (
          <Link href="/escalations" className="border-t border-warning/30 bg-warning/[0.06] px-4 py-2.5 transition-colors hover:bg-warning/10" title={topTitle}>
            <div className="flex items-center gap-1.5 text-tiny font-semibold uppercase tracking-wide text-warning">
              <ShieldAlert size={12} aria-hidden />{t.common.escalationsWaiting.replace('{count}', String(escalationCount))}
            </div>
            <div className="mt-0.5 truncate text-xs text-text">{topTitle}</div>
          </Link>
        );
      })()}

      {expanded && nextReady && (
        <Link href="/tasks" className="border-t border-border px-4 py-2.5 transition-colors hover:bg-elevated" title={nextReady.title}>
          <div className="text-tiny font-medium uppercase tracking-wide text-text-muted">{t.common.nextReady}</div>
          <div className="mt-0.5 truncate text-xs text-text">{nextReady.title}</div>
        </Link>
      )}

      <OpsStatusBar expanded={expanded} />

      {/* Thin footer: account link (avatar + name + role) with the live daemon-health as a corner
          dot, then the notify bell + theme toggle + language dropdown — all on one compact row when
          expanded, stacked in the narrow rail. */}
      <div className={`flex border-t border-border px-3 py-2 ${expanded ? 'items-center gap-1.5' : 'flex-col items-center gap-2'}`}>
        <Link
          href="/account"
          className={`flex min-w-0 items-center gap-2 rounded-md py-1 transition-colors hover:bg-elevated ${expanded ? 'flex-1 px-1' : ''}`}
          title={me.data?.user ? (me.data.user.name || me.data.user.username) : t.common.daemon}
        >
          <span className="relative flex shrink-0 items-center justify-center">
            {me.data?.user
              ? <Avatar user={me.data.user} size={28} />
              : <span className="flex h-7 w-7 items-center justify-center rounded-full border border-border bg-elevated"><User size={14} className="text-text-muted" aria-hidden /></span>}
            <span
              role="status"
              aria-label={up ? t.common.daemonUp : t.common.daemonDown}
              title={status === 'fail' ? t.common.daemonOffline : status === 'busy' ? t.common.daemonBusy : t.common.daemonReady}
              className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface ${up ? 'live-dot' : ''}`}
              style={{ backgroundColor: DAEMON_STATUS[status].color, ['--live-ring' as string]: DAEMON_STATUS[status].ring }}
            />
          </span>
          {expanded && me.data?.user && (
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-xs font-medium text-text">{me.data.user.name || me.data.user.username}</span>
              <span className="truncate text-tiny text-text-muted">{me.data.user.is_admin ? t.users.admin : t.users.member}</span>
            </span>
          )}
        </Link>
        <NotificationBell />
        <ThemeToggle />
        <LanguageSwitcher collapsed={!expanded} side={side} />
      </div>

      {/* Version + authorship credit — its own line-separated footer at the very bottom. */}
      {expanded && (
        <div className="flex flex-col items-center gap-0.5 border-t border-border px-3 py-2 text-center">
          <span className="font-mono text-tiny text-text-muted">orca v{data?.version ?? '—'}</span>
          <a
            href="https://dragocz.dev"
            target="_blank"
            rel="noreferrer"
            className="text-tiny font-semibold uppercase tracking-[0.15em] text-text-muted/70 transition-colors hover:text-text"
          >
            by dragocz.dev
          </a>
        </div>
      )}

      {/* Pill handle toggle (pins collapsed/expanded) — only when the user's pin actually decides
          (`full`); a space-forced rail ignores the pin, so the toggle would be a no-op there. */}
      {mode === 'full' && (
        <button
          type="button"
          aria-label={t.common.toggleSidebar}
          onClick={toggle}
          className={`group absolute ${side === 'right' ? '-left-2.5' : '-right-2.5'} top-1/2 z-10 flex h-14 w-4 -translate-y-1/2 cursor-pointer items-center justify-center`}
        >
          <span className="h-9 w-1 rounded-full bg-border-strong transition-all duration-200 group-hover:h-12 group-hover:bg-text-muted" />
        </button>
      )}

      {!drawer && expanded && (
        <div
          data-testid="sidebar-resize"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDoubleClick={() => setWidth(224)}
          className={`absolute ${side === 'right' ? 'left-0' : 'right-0'} top-0 h-full w-1 cursor-col-resize`}
        />
      )}
    </nav>
    </>
  );
}
