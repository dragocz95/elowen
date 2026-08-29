'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight, LogOut, Menu, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Search, User } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { useMe } from '../../lib/queries';
import { useSignOut } from '../../lib/mutations';
import { PageTopBarHost, usePageHeader } from '../../lib/pageHeader';
import { navigationWorldForPath } from '../../modules/registry';
import { Avatar } from '../ui/Avatar';
import { LanguageSwitcher } from '../ui/LanguageSwitcher';
import { SkinSwitcher } from '../ui/SkinSwitcher';
import { COMMAND_PALETTE_OPEN_EVENT } from './CommandPalette';

/** How the page's chrome claims its room.
 *
 *  `floating` is the built-in design's: no bar at all, a frameless masthead with the location set large
 *  and the universal actions gathered into a blurred pill floating over the canvas.
 *  `bar` is the dashboard reading: a compact sticky rule across the top of the scroller, the current page's
 *  own controls on the left and the universal actions on the right as plain ghost controls. Its 48px base
 *  height may be retuned by the command skin together with the sticky table-header offset.
 *
 *  It is a typed property of the SHELL, chosen once from `shellProfileFor()` — never a skin id read here,
 *  and never a utility class fighting an unlayered stylesheet for the same layout. */
export type PageBarVariant = 'floating' | 'bar';

/** Page chrome: the reader's location plus the universal actions. */
export function TopBar({ onMenuClick, onNavToggle, navCollapsed = false, navSide = 'left', showLocation = true, variant = 'floating', hideOnPhone = false }: {
  onMenuClick?: () => void;
  onNavToggle?: () => void;
  navCollapsed?: boolean;
  navSide?: 'left' | 'right';
  showLocation?: boolean;
  variant?: PageBarVariant;
  /** Withhold the whole bar below 768px. /chat carries its own conversation bar there, and stacking the
   *  global one above it crowds the screen.
   *
   *  It is a property of THIS component and not a wrapper the shell puts around it, because the `bar`
   *  variant is `position: sticky` and a sticky box is clamped to its containing block. A wrapper whose
   *  only child is the header is exactly the header's height, which gives it a sticky range of zero: the
   *  bar scrolled away on the first wheel click, and `.data-table-header`, which offsets itself by the
   *  active bar height precisely because the bar stays, parked every register's column names below a gap
   *  with rows scrolling visibly above them. */
  hideOnPhone?: boolean;
}) {
  const { t } = useTranslation();
  const me = useMe();
  const pathname = usePathname();
  const pageHeader = usePageHeader();
  const { signOut, isPending: signingOut } = useSignOut();
  const { title, count, icon: Icon } = pageHeader?.header ?? {};
  const world = navigationWorldForPath(pathname);
  const context = world
    ? t.nav[world.id]
    : pathname.startsWith('/account') || pathname.startsWith('/settings') || pathname.startsWith('/users')
      ? t.nav.system
      : undefined;
  const bar = variant === 'bar';
  const NavOpenIcon = navSide === 'right' ? PanelRightOpen : PanelLeftOpen;
  const NavCloseIcon = navSide === 'right' ? PanelRightClose : PanelLeftClose;

  // The two variants differ in what the row IS — a floating cluster over the canvas versus a ruled bar
  // that content scrolls under — so the geometry is chosen here rather than patched on afterwards.
  const control = bar
    ? 'h-8 rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text'
    : 'h-9 rounded-full text-text-muted transition-colors hover:bg-elevated hover:text-text';

  return (
    <header
      data-testid="future-page-header"
      className={`${bar
        ? 'top-bar top-bar--bar sticky top-0 z-30 flex h-12 shrink-0 items-center gap-3 border-b border-border bg-bg px-4'
        : 'top-bar relative z-30 flex min-h-16 shrink-0 items-start justify-between gap-4 px-4 pb-2 pt-3'}${hideOnPhone ? ' max-[767px]:hidden' : ''}`}
    >
      <div className={`top-bar__leading min-w-0 items-center gap-2 ${bar || showLocation || onMenuClick || onNavToggle ? 'flex' : 'hidden'} ${bar ? 'flex-1' : 'items-start gap-3'}`}>
        {onMenuClick ? (
          <button
            type="button"
            onClick={onMenuClick}
            aria-label={t.common.toggleSidebar}
            className={bar
              ? 'top-bar__menu -ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text pointer-coarse:h-[var(--touch-target)] pointer-coarse:w-[var(--touch-target)]'
              : 'top-bar__menu mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border/80 bg-bg/55 text-text-muted backdrop-blur-md transition-colors hover:border-accent/40 hover:text-accent'}
          >
            <Menu size={bar ? 18 : 19} strokeWidth={bar ? 1.5 : 2} aria-hidden />
          </button>
        ) : null}
        {bar && onNavToggle ? (
          <button
            type="button"
            onClick={onNavToggle}
            data-testid="studio-nav-collapse"
            data-nav-side={navSide}
            aria-label={navCollapsed ? t.common.expandNav : t.common.collapseNav}
            title={`${navCollapsed ? t.common.expandNav : t.common.collapseNav} · ${t.nav.collapseShortcut}`}
            aria-keyshortcuts="Control+Backslash Meta+Backslash"
            className="top-bar__nav-toggle flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text"
          >
            {navCollapsed
              ? <NavOpenIcon size={20} strokeWidth={1.5} aria-hidden />
              : <NavCloseIcon size={20} strokeWidth={1.5} aria-hidden />}
          </button>
        ) : null}
        {bar && showLocation && title ? (
          <div className="top-bar__location flex min-w-0 shrink-0 items-center gap-2">
            {Icon ? <Icon size={18} strokeWidth={1.5} aria-hidden /> : null}
            <span className="truncate text-sm font-medium text-text">{title}</span>
            {count !== undefined ? <span className="font-mono text-xs text-text-muted">{count}</span> : null}
          </div>
        ) : null}
        {/* Route-specific controls live in the page that owns their state and portal into this slot. The
            sidebar remains the only global navigation; this bar is the current page's own toolbar. */}
        {bar ? <PageTopBarHost className="top-bar__page-slot flex min-w-0 flex-1 items-center empty:hidden" /> : null}
        {!bar && showLocation ? (
          <>
            {Icon && onMenuClick ? <span className="mt-1.5 hidden h-9 w-9 shrink-0 place-items-center rounded-full border border-accent/20 bg-accent/[0.07] text-accent sm:grid"><Icon size={17} strokeWidth={1.5} aria-hidden /></span> : null}
            <div className="flex min-w-0 flex-col gap-1">
              {context ? <span className="flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[.16em] text-accent/75">{context}{context && title ? <ChevronRight size={11} aria-hidden /> : null}</span> : null}
              <div className="flex min-w-0 items-baseline gap-3">
                {title ? <h1 className="truncate font-display text-2xl font-semibold tracking-[-0.035em] text-text">{title}</h1> : null}
                {count !== undefined ? <span className="shrink-0 font-mono text-xs text-text-muted">{count}</span> : null}
              </div>
            </div>
          </>
        ) : null}
      </div>

      {/* The action cluster and the hamburger are named — `top-bar__*` — because they are the only chrome
          on every page of the app and a skin has to be able to reach them. Their LAYOUT is the variant's,
          not a stylesheet's: a skin that had to un-pill this cluster from outside was overriding four
          declarations to undo four others. */}
      <div className={bar
        ? 'top-bar__actions ml-auto flex shrink-0 items-center gap-0.5 max-[767px]:hidden'
        : 'top-bar__actions ml-auto flex shrink-0 items-center gap-1 rounded-full border border-border/70 bg-bg/45 p-1 backdrop-blur-xl'}>
        {/* Command search is a control among the others, never a field of its own. A named input parked in
            the middle of the bar claimed the widest slot in the app's chrome for something reached by
            shortcut, and on /chat it split that page's own toolbar away from its title. As an icon it sits
            with the actions it belongs to; the shortcut still opens the same palette. The floating cluster
            keeps the ⌘K hint beside the glyph because it has the room. */}
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT))}
          aria-label={t.common.openCommandPalette}
          title={`${t.common.openCommandPalette} · ⌘K`}
          aria-keyshortcuts="Control+K Meta+K"
          className={`top-bar__search group flex items-center justify-center ${bar ? 'w-8' : 'gap-2 px-2.5'} ${control}`}
        >
          <Search size={bar ? 18 : 17} strokeWidth={bar ? 1.5 : undefined} aria-hidden />
          {!bar ? <span className="hidden font-mono text-[10px] tracking-wide text-text-muted/70 lg:inline">⌘K</span> : null}
        </button>
        {/* Only when there is a session to end — the login screen has nothing to sign out of. */}
        {me.data?.user ? (
          <button
            type="button"
            onClick={signOut}
            disabled={signingOut}
            aria-label={t.common.logout}
            title={t.common.logout}
            className={`flex w-9 items-center justify-center disabled:opacity-50 ${control}`}
          >
            <LogOut size={18} strokeWidth={1.5} aria-hidden />
          </button>
        ) : null}
        <SkinSwitcher collapsed={Boolean(onMenuClick)} />
      <LanguageSwitcher collapsed={Boolean(onMenuClick)} />
        <Link
          href="/account"
          className="top-bar__identity ml-0.5 flex items-center rounded-full ring-accent/30 transition-[opacity,box-shadow] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2"
          title={me.data?.user ? (me.data.user.name || me.data.user.username) : t.common.daemon}
        >
          {me.data?.user ? (
            <Avatar user={me.data.user} size={bar ? 26 : 34} />
          ) : (
            <span className={`flex items-center justify-center rounded-full border border-border bg-elevated ${bar ? 'h-[26px] w-[26px]' : 'h-[34px] w-[34px]'}`}><User size={bar ? 15 : 17} className="text-text-muted" aria-hidden /></span>
          )}
        </Link>
      </div>
    </header>
  );
}
