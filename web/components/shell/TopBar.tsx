'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight, Menu, Search, User } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { useMe } from '../../lib/queries';
import { usePageHeader } from '../../lib/pageHeader';
import { navigationWorldForPath } from '../../modules/registry';
import { NotificationBell } from '../ui/NotificationBell';
import { Avatar } from '../ui/Avatar';
import { LanguageSwitcher } from '../ui/LanguageSwitcher';
import { COMMAND_PALETTE_OPEN_EVENT } from './CommandPalette';

/** A calm global bar: location context on the left, universal actions on the right. */
export function TopBar({ onMenuClick }: { onMenuClick?: () => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const pathname = usePathname();
  const pageHeader = usePageHeader();
  const { title, count, icon: Icon } = pageHeader?.header ?? {};
  const world = navigationWorldForPath(pathname);
  const context = world
    ? t.nav[world.id]
    : pathname.startsWith('/account') || pathname.startsWith('/settings') || pathname.startsWith('/users')
      ? t.nav.system
      : pathname.startsWith('/escalations')
        ? t.sidebar.notifications
        : undefined;

  return (
    <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center justify-between gap-3 border-b border-border/80 bg-bg/75 px-4 backdrop-blur-xl">
      <div className="flex min-w-0 items-center gap-2.5">
        {onMenuClick ? (
          <button
            type="button"
            onClick={onMenuClick}
            aria-label={t.common.toggleSidebar}
            className="-ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-transparent text-text-muted transition-colors hover:border-border hover:bg-elevated hover:text-text"
          >
            <Menu size={19} aria-hidden />
          </button>
        ) : null}
        {Icon ? <Icon size={19} strokeWidth={1.6} className="shrink-0 text-accent" aria-hidden /> : null}
        <div className="flex min-w-0 items-center gap-2">
          {context ? <span className="hidden shrink-0 text-xs font-medium text-text-muted sm:inline">{context}</span> : null}
          {context && title ? <ChevronRight size={13} className="hidden shrink-0 text-text-muted/50 sm:block" aria-hidden /> : null}
          {title ? <h1 className="truncate text-base font-semibold tracking-tight text-text sm:text-lg">{title}</h1> : null}
          {count !== undefined ? <span className="shrink-0 rounded-full border border-border bg-elevated px-2 py-0.5 font-mono text-[11px] text-text-muted">{count}</span> : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT))}
          aria-label={t.common.openCommandPalette}
          title={t.common.openCommandPalette}
          className="group flex h-9 items-center gap-2 rounded-xl border border-transparent px-2.5 text-text-muted transition-colors hover:border-border hover:bg-elevated hover:text-text"
        >
          <Search size={17} aria-hidden />
          <span className="hidden font-mono text-[10px] tracking-wide text-text-muted/70 lg:inline">⌘K</span>
        </button>
        <NotificationBell />
        <LanguageSwitcher />
        <Link
          href="/account"
          className="ml-0.5 flex items-center rounded-full ring-accent/30 transition-[opacity,box-shadow] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2"
          title={me.data?.user ? (me.data.user.name || me.data.user.username) : t.common.daemon}
        >
          {me.data?.user ? (
            <Avatar user={me.data.user} size={34} />
          ) : (
            <span className="flex h-[34px] w-[34px] items-center justify-center rounded-full border border-border bg-elevated"><User size={17} className="text-text-muted" aria-hidden /></span>
          )}
        </Link>
      </div>
    </header>
  );
}
