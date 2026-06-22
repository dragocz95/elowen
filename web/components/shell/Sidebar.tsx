'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Languages, User, ShieldAlert } from 'lucide-react';
import { modulesByGroup } from '../../modules/registry';
import { useSidebarState } from '../../lib/useSidebarState';
import { useHealth, useTasks, useMe, useEscalations } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { NavGroup } from './NavGroup';
import { OpsStatusBar } from './OpsStatusBar';
import { NotificationBell } from '../ui/NotificationBell';
import { Avatar } from '../ui/Avatar';

const RAIL = 56;
const DAEMON_STATUS = {
  ready: { color: 'var(--color-success)', ring: 'color-mix(in srgb, var(--color-success) 50%, transparent)' },
  busy: { color: 'var(--color-warning)', ring: 'color-mix(in srgb, var(--color-warning) 50%, transparent)' },
  fail: { color: 'var(--color-error)', ring: 'color-mix(in srgb, var(--color-error) 50%, transparent)' },
} as const;

export function Sidebar({ mobileOpen = false, onMobileClose }: { mobileOpen?: boolean; onMobileClose?: () => void }) {
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

  // On mobile the sidebar is a drawer (always full-width content); on desktop it collapses to a rail.
  const expanded = mobile ? true : !collapsed;

  // Close the mobile drawer after navigating.
  useEffect(() => { if (mobile) onMobileClose?.(); }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

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
    <>
      {mobile && (
        <div
          aria-hidden
          onClick={onMobileClose}
          className={`fixed inset-0 z-40 bg-black/50 transition-opacity md:hidden ${mobileOpen ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
        />
      )}
    <nav
      aria-label={t.common.primaryNav}
      className={mobile
        ? `fixed inset-y-0 left-0 z-50 flex h-full w-[264px] flex-col overflow-hidden border-r border-border bg-surface transition-transform duration-200 md:hidden ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`
        : 'relative hidden h-full shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-200 md:flex'}
      style={mobile ? { transitionTimingFunction: 'var(--ease-out)' } : { width: expanded ? width : RAIL, transitionTimingFunction: 'var(--ease-out)' }}
    >
      <div className="flex items-center justify-center border-b border-border px-3 py-3 overflow-hidden">
        {expanded
          ? <img src="/orca-logo.png" alt={t.common.appName} className="h-9 w-auto" />
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
                  badge: m.id === 'escalations' ? escalations.length : undefined,
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
      {expanded && escalations.length > 0 && (
        <Link href="/escalations" className="border-t border-warning/30 bg-warning/[0.06] px-4 py-2.5 transition-colors hover:bg-warning/10" title={escalations[0]!.title}>
          <div className="flex items-center gap-1.5 text-tiny font-semibold uppercase tracking-wide text-warning">
            <ShieldAlert size={12} aria-hidden />{t.common.escalationsWaiting.replace('{count}', String(escalations.length))}
          </div>
          <div className="mt-0.5 truncate text-xs text-text">{escalations[0]!.title}</div>
        </Link>
      )}

      {expanded && nextReady && (
        <Link href="/tasks" className="border-t border-border px-4 py-2.5 transition-colors hover:bg-elevated" title={nextReady.title}>
          <div className="text-tiny font-medium uppercase tracking-wide text-text-muted">{t.common.nextReady}</div>
          <div className="mt-0.5 truncate text-xs text-text">{nextReady.title}</div>
        </Link>
      )}

      <OpsStatusBar expanded={expanded} />

      {/* Thin footer: account link (avatar + name + role) with the live daemon-health as a corner
          dot, plus the language toggle — one compact bar instead of a verbose status block. */}
      <div className={`border-t border-border px-3 py-2 ${expanded ? 'flex items-center gap-2' : 'flex flex-col items-center gap-2'}`}>
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
        {expanded && (
          <button
            type="button"
            onClick={() => setLocale(locale === 'en' ? 'cs' : 'en')}
            className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-tiny font-mono uppercase tracking-wide text-text-muted transition-colors hover:border-border-strong hover:text-text"
            aria-label={t.common.switchLang}
          >
            <Languages size={12} aria-hidden />
            {locale === 'en' ? 'CS' : 'EN'}
          </button>
        )}
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

      {/* Pill handle toggle (pins collapsed/expanded) — desktop only */}
      {!mobile && (
        <button
          type="button"
          aria-label={t.common.toggleSidebar}
          onClick={toggle}
          className="group absolute -right-2 top-1/2 z-10 flex h-14 w-4 -translate-y-1/2 items-center justify-center"
        >
          <span className="h-9 w-1 rounded-full bg-border transition-all duration-200 group-hover:h-12 group-hover:bg-text-muted" />
        </button>
      )}

      {!mobile && expanded && (
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
    </>
  );
}
