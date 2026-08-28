'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, MoreHorizontal, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import { useBrand } from '../../lib/brand';
import { useHealth } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { useShellNavigation } from './useShellNavigation';
import { useNavCustomization } from './NavCustomization';
import { navOrderIndex } from './navOrder';
import { entryIsActive, type NavEntry } from './navEntry';

/** The entries Studio presents in its footer region rather than in the scrolling body: the account and
 *  the administration pages, which are where you GO from the studio rather than what you work in.
 *
 *  They stay ordinary customizable entries — the same context menu hides, restores and reorders them —
 *  only the region they are drawn in differs. That is why the surface order handed to the customization
 *  hook below is body-then-footer: it is the sequence the reader actually sees. */
const FOOTER_ENTRY_IDS = ['account', 'settings', 'users'];

const isFooterEntry = (entry: NavEntry): boolean => entry.id !== undefined && FOOTER_ENTRY_IDS.includes(entry.id);

/** The pages a world contributes as a GROUP, or null when it is a plain destination.
 *
 *  A world with one sub-item is not a group: `projects` names its own single page, so drawing a header
 *  over one child that repeats the header's label is a disclosure with nothing to disclose. Two or more
 *  is a real group, and then EVERY page goes inside it — including the one the world's own `href` points
 *  at, which is why the header is a disclosure button rather than a link. Splitting the first page out
 *  onto the header is what would make it reachable only by guessing. */
function groupPages(entry: NavEntry): NavEntry['subItems'] | null {
  return entry.subItems && entry.subItems.length > 1 ? entry.subItems : null;
}

/** Whether the sidebar's fold is toggled from the keyboard by this event.
 *
 *  `Ctrl`/`⌘` + `\` is deliberately not a browser binding — unlike `Ctrl+B` (Firefox bookmarks sidebar),
 *  `Ctrl+Shift+K` (Firefox console) or `⌘+.` (Safari stop) — and it does not collide with the command
 *  palette's `Ctrl/⌘+K`. The physical key is matched through `code` so a non-US layout, where the glyph
 *  sits elsewhere, still folds the sidebar with the key the label names. */
function isCollapseShortcut(event: KeyboardEvent): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return false;
  return event.code === 'Backslash' || event.key === '\\';
}

/** Studio's command-grid navigation: an inset column with a sticky brand header, a scrolling grouped
 *  body and an account/administration footer. It renders the SAME navigation model the spatial rail does
 *  — one registry, one arrangement, one active-route rule — in the flat, dense presentation the Studio
 *  design asks for.
 *
 *  Every dimension, hairline and state colour lives in `web/skins/studio/shared.css`; this component only
 *  states WHAT it is (`studio-nav__*` classes) and WHAT STATE it is in (`data-*` attributes). Nothing
 *  here carries a utility class the skin would then have to out-specify, and nothing here paints. It is
 *  mounted exclusively under a `command` shell profile, i.e. only while one of those stylesheets is on. */
export function StudioNavigation({ compact = false, side = 'left', onToggleCollapse, drawer = false, drawerOpen = false, onDrawerClose }: {
  compact?: boolean;
  side?: 'left' | 'right';
  onToggleCollapse?: () => void;
  drawer?: boolean;
  drawerOpen?: boolean;
  onDrawerClose?: () => void;
}) {
  const pathname = usePathname();
  const { t } = useTranslation();
  const { appName, iconSrc } = useBrand();
  const health = useHealth();
  const { worlds, allWorlds, layout, layoutReady } = useShellNavigation();

  // An untouched menu keeps the shared default sequence, which carries meaning of its own (where you
  // land, the work, what it runs on, administration). Once the user has arranged the menu, their order
  // is already in `worlds` and wins outright.
  const sequence = useMemo<NavEntry[]>(() => (layout.order.length === 0
    ? [...worlds].sort((a, b) => navOrderIndex(a.href) - navOrderIndex(b.href))
    : worlds), [worlds, layout.order.length]);
  const bodyEntries = useMemo(() => sequence.filter((entry) => !isFooterEntry(entry)), [sequence]);
  const footerEntries = useMemo(() => sequence.filter(isFooterEntry), [sequence]);
  // THIS surface's own visible order, which is what the first edit seeds the stored order from. Handing
  // over the rail's order instead would reshuffle the sidebar the moment anything was hidden or moved.
  const displayOrder = useMemo(
    () => [...bodyEntries, ...footerEntries].flatMap((entry) => (entry.id ? [entry.id] : [])),
    [bodyEntries, footerEntries],
  );
  const customization = useNavCustomization(allWorlds, layout, displayOrder);

  // Which groups the reader has folded shut. Groups start open — a sidebar that hides its destinations
  // by default makes the reader work to find out what exists — so this only ever records a deliberate
  // close, and an id absent from it is open.
  const [closedGroups, setClosedGroups] = useState<Record<string, boolean>>({});
  const toggleGroup = (id: string) => setClosedGroups((current) => ({ ...current, [id]: !current[id] }));

  const navRef = useRef<HTMLElement | null>(null);
  // Arriving somewhere is the end of navigating, so the sheet gets out of the way on its own. The close
  // callback is an unstable inline prop from the shell — deliberately not a dependency.
  useEffect(() => { if (drawer) onDrawerClose?.(); }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  // An overlay the keyboard cannot close, and that focus never enters, is a layer only the mouse knows
  // about. Focus goes in on open and returns to whatever opened it on close.
  const returnFocusTo = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!drawer) return;
    if (drawerOpen) {
      returnFocusTo.current = document.activeElement as HTMLElement | null;
      navRef.current?.querySelector<HTMLElement>('a[href], button')?.focus();
      const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onDrawerClose?.(); };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }
    // Only take focus back if it is still inside the sheet; the user may have clicked elsewhere.
    if (navRef.current?.contains(document.activeElement)) returnFocusTo.current?.focus();
    returnFocusTo.current = null;
    return undefined;
  }, [drawer, drawerOpen, onDrawerClose]);

  // The fold is a desktop affordance, so the shortcut exists exactly where the control does: `onToggleCollapse`
  // is absent in the drawer and in a window already forced to the icon column, where it could change nothing.
  useEffect(() => {
    if (!onToggleCollapse) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (!isCollapseShortcut(event)) return;
      event.preventDefault();
      onToggleCollapse();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onToggleCollapse]);

  const hidden = drawer && !drawerOpen;
  const mode = drawer ? 'drawer' : compact ? 'rail' : 'full';
  const status = health.isError || health.data?.ok === false ? 'offline' : health.data ? 'online' : 'checking';
  const statusLabel = status === 'online' ? t.nav.statusOnline : status === 'offline' ? t.nav.statusOffline : t.nav.statusChecking;
  const collapseLabel = compact ? t.common.expandNav : t.common.collapseNav;

  /** One destination row, at either depth. Only the icon column drops its label text — the sheet is a
   *  full-width panel and keeps it — so `aria-label` names the row exactly where the label is NOT on
   *  screen, and `title` carries the full text exactly where it is, keeping a truncated label readable. */
  const destination = (entry: NavEntry, depth: 0 | 1, onContextMenu?: (event: React.MouseEvent) => void) => {
    const active = entryIsActive(entry, pathname);
    const Icon = entry.icon;
    return (
      <Link
        href={entry.href ?? '#'}
        className="studio-nav__item"
        data-depth={depth}
        data-active={active || undefined}
        aria-current={active ? 'page' : undefined}
        aria-label={compact ? entry.label : undefined}
        title={compact ? undefined : entry.label}
        onContextMenu={onContextMenu}
      >
        <span className="studio-nav__item-icon" aria-hidden><Icon size={16} strokeWidth={1.6} /></span>
        {compact ? null : <span className="studio-nav__item-label">{entry.label}</span>}
      </Link>
    );
  };

  return (
    <>
      {drawer ? (
        <div
          aria-hidden
          onClick={onDrawerClose}
          className="studio-nav__scrim overlay-layer-nav-drawer"
          data-open={drawerOpen || undefined}
        />
      ) : null}
      <nav
        ref={navRef}
        className={`studio-nav${drawer ? ' overlay-layer-nav-drawer overlay-nav-drawer' : ''}`}
        data-testid="studio-navigation"
        data-mode={mode}
        data-side={side}
        data-open={drawer && drawerOpen ? true : undefined}
        data-ready={layoutReady || undefined}
        // As a sheet this is a layer over the page that takes focus and traps Escape, so it says so.
        // `aria-modal` is claimed only while it is actually open — a closed sheet is inert chrome.
        role={drawer ? 'dialog' : undefined}
        aria-modal={drawer && drawerOpen ? true : undefined}
        aria-label={t.common.primaryNav}
        aria-hidden={hidden ? true : undefined}
        inert={hidden ? true : undefined}
        // Anywhere on the surface that is not a destination opens the editor — that is how a hidden
        // entry is found again.
        onContextMenu={customization.onSurfaceContextMenu}
      >
        {/* A dialog needs a way out that is not "guess that the strip of backdrop is a target". First in
            the DOM so the open effect above lands focus on it. */}
        {drawer ? (
          <button
            type="button"
            onClick={onDrawerClose}
            aria-label={t.common.close}
            className="studio-nav__close overlay-touch-target"
          >
            <X size={18} aria-hidden />
          </button>
        ) : null}

        <header className="studio-nav__brand">
          <img className="studio-nav__brand-mark" src={iconSrc} alt="" width={22} height={22} />
          {compact ? null : <span className="studio-nav__brand-name">{appName}</span>}
          <span className="studio-nav__status" role="status" data-state={status} aria-label={statusLabel} title={statusLabel}>
            <span className="studio-nav__beacon" aria-hidden />
            {compact ? null : <span className="studio-nav__status-text" aria-hidden>{statusLabel}</span>}
          </span>
        </header>

        <div className="studio-nav__body">
          {bodyEntries.map((entry) => {
            const pages = groupPages(entry);
            const key = entry.id ?? entry.label;
            const onEntryMenu = entry.id
              ? (event: React.MouseEvent) => customization.onEntryContextMenu(event, entry)
              : customization.onSurfaceContextMenu;
            if (!pages) return <div key={key} className="studio-nav__row">{destination(entry, 0, onEntryMenu)}</div>;

            const active = entryIsActive(entry, pathname);
            // A page inherits its world's icon when it brings none, so the row is never iconless in the
            // icon column — where the icon is the entire row.
            const page = (item: NonNullable<NavEntry['subItems']>[number]): NavEntry => ({ ...item, icon: item.icon ?? entry.icon });
            // The icon column has no room for a disclosure, so groups do not fold there at all — every
            // page stays one click away. Where the fold IS offered, closing a group that holds the
            // current page keeps that one page on screen: a destination the reader is standing on must
            // never disappear out of the menu they navigate with.
            const closed = !compact && (closedGroups[key] ?? false);
            const shown = closed ? pages.filter((item) => entryIsActive(page(item), pathname)) : pages;
            const Icon = entry.icon;
            return (
              <div key={key} className="studio-nav__group" data-closed={closed || undefined} data-active={active || undefined}>
                {compact ? null : (
                  <button
                    type="button"
                    className="studio-nav__group-toggle"
                    data-active={active || undefined}
                    aria-expanded={!closed}
                    onClick={() => toggleGroup(key)}
                    onContextMenu={onEntryMenu}
                  >
                    <span className="studio-nav__item-icon" aria-hidden><Icon size={16} strokeWidth={1.6} /></span>
                    <span className="studio-nav__item-label">{entry.label}</span>
                    <ChevronRight className="studio-nav__chevron" size={13} aria-hidden />
                  </button>
                )}
                <div className="studio-nav__group-items">
                  {shown.map((item) => (
                    <div key={item.id} className="studio-nav__row">{destination(page(item), 1, onEntryMenu)}</div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <footer className="studio-nav__footer">
          {footerEntries.map((entry) => (
            <div key={entry.id ?? entry.label} className="studio-nav__row">
              {destination(entry, 0, entry.id
                ? (event: React.MouseEvent) => customization.onEntryContextMenu(event, entry)
                : customization.onSurfaceContextMenu)}
            </div>
          ))}
          <div className="studio-nav__footer-actions">
            {/* The keyboard's way into the menu the right-click opens. It has to exist independently of
                the entries: hide them all and there is nothing left to open a menu ON. */}
            <button
              type="button"
              className="studio-nav__action overlay-touch-target"
              aria-label={t.nav.showHidden}
              title={t.nav.showHidden}
              onClick={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                customization.openSurfaceMenu(box.left + box.width / 2, box.top);
              }}
            >
              <MoreHorizontal size={14} aria-hidden />
            </button>
            {onToggleCollapse ? (
              <button
                type="button"
                className="studio-nav__action overlay-touch-target"
                data-testid="studio-nav-collapse"
                aria-label={collapseLabel}
                title={`${collapseLabel} · ${t.nav.collapseShortcut}`}
                aria-keyshortcuts="Control+Backslash Meta+Backslash"
                onClick={onToggleCollapse}
              >
                {compact ? <PanelLeftOpen size={14} aria-hidden /> : <PanelLeftClose size={14} aria-hidden />}
              </button>
            ) : null}
            {compact ? null : (
              <span className="studio-nav__version">{health.data?.version ? `v${health.data.version}` : '—'}</span>
            )}
          </div>
        </footer>
      </nav>
      {customization.overlays}
    </>
  );
}
