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

/** Frameless page masthead: large location title plus quiet universal actions, never a top bar. */
export function TopBar({ onMenuClick, showLocation = true }: { onMenuClick?: () => void; showLocation?: boolean }) {
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
    <header data-testid="future-page-header" className="relative z-30 flex min-h-16 shrink-0 items-start justify-between gap-4 px-4 pb-2 pt-3">
      <div className={`min-w-0 items-start gap-3 ${showLocation ? 'flex' : 'hidden'}`}>
        {onMenuClick ? (
          <button
            type="button"
            onClick={onMenuClick}
            aria-label={t.common.toggleSidebar}
            className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border/80 bg-black/55 text-text-muted backdrop-blur-md transition-colors hover:border-accent/40 hover:text-accent"
          >
            <Menu size={19} aria-hidden />
          </button>
        ) : null}
        {Icon && onMenuClick ? <span className="mt-1.5 hidden h-9 w-9 shrink-0 place-items-center rounded-full border border-accent/20 bg-accent/[0.07] text-accent sm:grid"><Icon size={17} strokeWidth={1.5} aria-hidden /></span> : null}
        <div className="flex min-w-0 flex-col gap-1">
          {context ? <span className="flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[.16em] text-accent/75">{context}{context && title ? <ChevronRight size={11} aria-hidden /> : null}</span> : null}
          <div className="flex min-w-0 items-baseline gap-3">
            {title ? <h1 className="truncate font-display text-2xl font-semibold tracking-[-0.035em] text-text">{title}</h1> : null}
            {count !== undefined ? <span className="shrink-0 font-mono text-xs text-text-muted">{count}</span> : null}
          </div>
        </div>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1 rounded-full border border-border/70 bg-black/45 p-1 backdrop-blur-xl">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT))}
          aria-label={t.common.openCommandPalette}
          title={t.common.openCommandPalette}
          className="group flex h-9 items-center gap-2 rounded-full px-2.5 text-text-muted transition-colors hover:bg-elevated hover:text-text"
        >
          <Search size={17} aria-hidden />
          <span className="hidden font-mono text-[10px] tracking-wide text-text-muted/70 lg:inline">⌘K</span>
        </button>
        <NotificationBell />
        <LanguageSwitcher collapsed={Boolean(onMenuClick)} />
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
