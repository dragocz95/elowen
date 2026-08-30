'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, MoreHorizontal, X } from 'lucide-react';
import { useBrand } from '../../lib/brand';
import { useHealth, useMe } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { Avatar } from '../ui/Avatar';
import { SkinSwitcher } from '../ui/SkinSwitcher';
import { useShellNavigation } from './useShellNavigation';
import { useNavCustomization } from './NavCustomization';
import { navOrderIndex } from './navOrder';
import { entryIsActive, type NavEntry } from './navEntry';
import { useNavDrawerFocus } from '../ui/focusCycle';

/** The entries Studio presents in its footer region rather than in the scrolling body: the account and
 *  the administration pages, which are where you GO from the studio rather than what you work in.
 *
 *  They stay ordinary customizable entries — the same context menu hides, restores and reorders them —
 *  only the region they are drawn in differs. That is why the surface order handed to the customization
 *  hook below is body-then-footer: it is the sequence the reader actually sees. */
const FOOTER_ENTRY_IDS = ['settings', 'users', 'account'];

/** The account entry, drawn as the sidebar's user block rather than as another destination row. It is
 *  still the same entry from the same model — it is hidden, restored and reordered exactly like the
 *  others — so this is a presentation rule and not a second source of navigation. */
const USER_ENTRY_ID = 'account';
const DRAG_THRESHOLD = 5;

type DragRegion = 'body' | 'footer';
type DragState = { id: string; region: DragRegion; from: number; to: number; dy: number; span: number };
type DragPress = {
  id: string;
  region: DragRegion;
  from: number;
  startY: number;
  pointerId: number;
  element: HTMLElement;
  centers: number[];
  span: number;
};

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

/** Studio's navigation column: a header naming the product, a scrolling grouped body of destinations and
 *  a footer holding administration and the signed-in account. It renders the SAME navigation model the
 *  spatial rail does — one registry, one arrangement, one active-route rule — in the flat, dense
 *  presentation the Studio design asks for.
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
  const me = useMe();
  const { worlds, allWorlds, layout, layoutReady } = useShellNavigation();

  // An untouched menu keeps the shared default sequence, which carries meaning of its own (where you
  // land, the work, what it runs on, administration). Once the user has arranged the menu, their order
  // is already in `worlds` and wins outright.
  const sequence = useMemo<NavEntry[]>(() => (layout.order.length === 0
    ? [...worlds].sort((a, b) => navOrderIndex(a.href) - navOrderIndex(b.href))
    : worlds), [worlds, layout.order.length]);
  const bodyEntries = useMemo(() => sequence.filter((entry) => !isFooterEntry(entry)), [sequence]);
  // The footer's own order is fixed rather than inherited: the user block is the last thing in the
  // column whatever the arrangement says, because it is the anchor the reader reaches for, not a
  // destination competing with the others. Hiding and restoring still work on every one of them.
  const footerEntries = useMemo(() => sequence.filter(isFooterEntry), [sequence]);
  const userEntry = footerEntries.find((entry) => entry.id === USER_ENTRY_ID);
  const adminEntries = footerEntries.filter((entry) => entry.id !== USER_ENTRY_ID);
  // THIS surface's own visible order, which is what the first edit seeds the stored order from. Handing
  // over the rail's order instead would reshuffle the sidebar the moment anything was hidden or moved.
  const displayOrder = useMemo(
    () => [...bodyEntries, ...adminEntries, ...(userEntry ? [userEntry] : [])]
      .flatMap((entry) => (entry.id ? [entry.id] : [])),
    [adminEntries, bodyEntries, userEntry],
  );
  const customization = useNavCustomization(allWorlds, layout, displayOrder);

  // Desktop Studio keeps the rail's direct-manipulation contract: hold the primary pointer and move a row.
  // Touch remains scrolling (and uses the context menu's keyboard-equivalent move actions), while the drawer
  // never rearranges underneath a finger that is trying to dismiss or navigate it.
  const entryRefs = useRef(new Map<string, HTMLDivElement>());
  const pressRef = useRef<DragPress | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const [drag, setDrag] = useState<DragState | null>(null);

  const regionEntries = (region: DragRegion) => region === 'body' ? bodyEntries : adminEntries;
  const releaseDrag = () => {
    const press = pressRef.current;
    const captured = !!dragRef.current;
    // Clear first: an explicit release emits `lostpointercapture`, whose handler must observe no live drag
    // rather than re-entering this cleanup against the same pointer.
    pressRef.current = null;
    dragRef.current = null;
    setDrag(null);
    if (press && captured) {
      try { press.element.releasePointerCapture(press.pointerId); } catch { /* capture already gone */ }
    }
  };
  const onEntryPointerDown = (event: React.PointerEvent<HTMLDivElement>, entry: NavEntry, region: DragRegion, slot: number) => {
    if (drawer || !entry.id || event.pointerType === 'touch' || (event.pointerType === 'mouse' && event.button !== 0)) return;
    suppressClick.current = false;
    const entries = regionEntries(region);
    const centers = entries.map((candidate) => {
      const element = candidate.id ? entryRefs.current.get(candidate.id) : undefined;
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return rect.top + rect.height / 2;
    });
    if (centers.some((center) => center === null)) return;
    const ownRect = event.currentTarget.getBoundingClientRect();
    const numericCenters = centers as number[];
    const neighbour = numericCenters[slot + 1] ?? numericCenters[slot - 1];
    pressRef.current = {
      id: entry.id,
      region,
      from: slot,
      startY: event.clientY,
      pointerId: event.pointerId,
      element: event.currentTarget,
      centers: numericCenters,
      span: neighbour === undefined ? ownRect.height : Math.abs(neighbour - numericCenters[slot]),
    };
  };
  const onEntryPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const press = pressRef.current;
    if (!press) return;
    const dy = event.clientY - press.startY;
    if (!dragRef.current && Math.abs(dy) < DRAG_THRESHOLD) return;
    if (!dragRef.current) {
      try { press.element.setPointerCapture(press.pointerId); } catch { /* pointer already gone */ }
    }
    const carried = press.centers[press.from] + dy;
    let to = press.from;
    let nearest = Number.POSITIVE_INFINITY;
    press.centers.forEach((center, index) => {
      const distance = Math.abs(center - carried);
      if (distance < nearest) { nearest = distance; to = index; }
    });
    const next = { id: press.id, region: press.region, from: press.from, to, dy, span: press.span };
    dragRef.current = next;
    setDrag(next);
  };
  const onEntryPointerUp = () => {
    const finished = dragRef.current;
    if (!finished) { pressRef.current = null; return; }
    suppressClick.current = true;
    const targetEntry = regionEntries(finished.region)[finished.to];
    // A stored layout may interleave destinations that Studio presents in separate body/footer regions.
    // `reorderNavEntry` consumes an index in THAT persisted visible order, not in this surface's partition.
    // On the first edit there is no persisted order yet, so the surface order is the only truthful seed.
    const target = targetEntry?.id
      ? (layout.order.length === 0
          ? displayOrder.indexOf(targetEntry.id)
          : worlds.findIndex((entry) => entry.id === targetEntry.id))
      : -1;
    releaseDrag();
    if (finished.to !== finished.from && target >= 0) customization.reorderTo(finished.id, target);
  };
  useEffect(() => {
    const clearUncapturedPress = () => {
      if (!dragRef.current) pressRef.current = null;
    };
    window.addEventListener('pointerup', clearUncapturedPress);
    window.addEventListener('pointercancel', releaseDrag);
    return () => {
      window.removeEventListener('pointerup', clearUncapturedPress);
      window.removeEventListener('pointercancel', releaseDrag);
      releaseDrag();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const entryShell = (entry: NavEntry, region: DragRegion, slot: number, child: React.ReactNode) => {
    const id = entry.id;
    const moving = !!id && drag?.id === id;
    let shift = 0;
    if (drag?.region === region) {
      if (moving) shift = drag.dy;
      else if (drag.from < drag.to && slot > drag.from && slot <= drag.to) shift = -drag.span;
      else if (drag.from > drag.to && slot < drag.from && slot >= drag.to) shift = drag.span;
    }
    return (
      <div
        ref={(element) => { if (id && element) entryRefs.current.set(id, element); else if (id) entryRefs.current.delete(id); }}
        className="studio-nav__entry-shell"
        data-nav-entry-id={id}
        data-dragging={moving || undefined}
        style={shift ? { transform: `translateY(${shift}px)` } : undefined}
        onPointerDown={(event) => onEntryPointerDown(event, entry, region, slot)}
        onLostPointerCapture={() => { if (dragRef.current) releaseDrag(); }}
        onClickCapture={(event) => {
          if (!suppressClick.current) return;
          suppressClick.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {child}
      </div>
    );
  };

  // Which groups the reader has folded shut. Groups start open — a sidebar that hides its destinations
  // by default makes the reader work to find out what exists — so this only ever records a deliberate
  // close, and an id absent from it is open.
  const [closedGroups, setClosedGroups] = useState<Record<string, boolean>>({});
  const toggleGroup = (id: string) => setClosedGroups((current) => ({ ...current, [id]: !current[id] }));

  const navRef = useRef<HTMLElement | null>(null);
  // Arriving somewhere is the end of navigating, so the sheet gets out of the way on its own. The close
  // callback is an unstable inline prop from the shell — deliberately not a dependency.
  useEffect(() => { if (drawer) onDrawerClose?.(); }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  // An overlay the keyboard cannot close, that focus never enters and that Tab walks straight out of,
  // is a layer only the mouse knows about — and `aria-modal` below would be a promise this sheet does
  // not keep. The shared hook owns all of it, identically here and in the spatial rail's drawer.
  useNavDrawerFocus({ enabled: drawer, open: drawerOpen, containerRef: navRef, onClose: onDrawerClose });

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
  const user = me.data?.user;

  /** One destination row, at either depth.
   *
   *  The label stays mounted so the 150ms opacity/translate collapse can finish, but is aria-hidden in the
   *  icon column; `aria-label` names the row exactly where the text is not presented. `title` is on both:
   *  expanded it keeps a truncated label readable, folded it explains the otherwise unlabelled 18px glyph. */
  const destination = (entry: NavEntry, onContextMenu?: (event: React.MouseEvent) => void, body?: React.ReactNode) => {
    const active = entryIsActive(entry, pathname);
    // A multi-page world's desktop row points at its default page while the TopBar carries the exact peer.
    // Keep the visual section highlight, but do not claim that default link is the current page elsewhere.
    const currentPage = active && ((entry.subItems?.length ?? 0) <= 1 || entry.href === pathname);
    const Icon = entry.icon;
    // A row with a custom body carries a face and a display name. Those are for the eye: the entry's
    // own label is what the row IS, and it is also what the arrangement menu addresses it by, so a row
    // that replaces its body is named by its attribute — exactly like a folded row whose text is off
    // screen. Otherwise the account row would announce itself as the signed-in person's name twice.
    const named = compact || body !== undefined;
    return (
      <Link
        href={entry.href ?? '#'}
        draggable={false}
        className="studio-nav__item"
        data-active={active || undefined}
        aria-current={currentPage ? 'page' : undefined}
        aria-label={named ? entry.label : undefined}
        title={entry.label}
        onContextMenu={onContextMenu}
      >
        {body !== undefined ? <span className="studio-nav__item-body" aria-hidden>{body}</span> : (
          <>
            <span className="studio-nav__item-icon" aria-hidden><Icon size={18} strokeWidth={1.5} /></span>
            <span className="studio-nav__item-label" aria-hidden={compact || undefined}>{entry.label}</span>
          </>
        )}
      </Link>
    );
  };

  const entryMenu = (entry: NavEntry) => (entry.id
    ? (event: React.MouseEvent) => customization.onEntryContextMenu(event, entry)
    : customization.onSurfaceContextMenu);

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
        onPointerMove={onEntryPointerMove}
        onPointerUp={onEntryPointerUp}
        onPointerCancel={releaseDrag}
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
            <X size={18} strokeWidth={1.5} aria-hidden />
          </button>
        ) : null}

        <header className="studio-nav__header">
          <div className="studio-nav__brand-lockup">
            <img className="studio-nav__brand-mark" src={iconSrc} alt="" width={20} height={20} />
            <span className="studio-nav__brand-name" aria-hidden={compact || undefined}>{appName}</span>
            {/* The build stays attached to the brand lockup. In rail mode the skin drops the name and the
                build and centres the mark — the folded column shows a logo, never a sliced word. */}
            {health.data?.version ? <span className="studio-nav__version" aria-hidden={compact || undefined}>{`v${health.data.version}`}</span> : null}
          </div>
        </header>

        <div className="studio-nav__body">
          {bodyEntries.map((entry, slot) => {
            const pages = groupPages(entry);
            const key = entry.id ?? entry.label;
            const onEntryMenu = entryMenu(entry);
            // Desktop/rail stays primary-only; peer pages move into the shared TopBar. The mobile drawer
            // keeps the nested destinations because that header strip is intentionally hidden there.
            if (!pages || !drawer) return <div key={key}>{entryShell(entry, 'body', slot, destination(entry, onEntryMenu))}</div>;

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
              <div key={key}>{entryShell(entry, 'body', slot, (
                <div className="studio-nav__group" data-closed={closed || undefined} data-active={active || undefined}>
                  {compact ? null : (
                    <button
                      type="button"
                      className="studio-nav__group-toggle"
                      data-active={active || undefined}
                      aria-expanded={!closed}
                      onClick={() => toggleGroup(key)}
                      onContextMenu={onEntryMenu}
                    >
                      <span className="studio-nav__item-icon" aria-hidden><Icon size={18} strokeWidth={1.5} /></span>
                      <span className="studio-nav__item-label">{entry.label}</span>
                      <ChevronRight className="studio-nav__chevron" size={14} aria-hidden />
                    </button>
                  )}
                  <div className="studio-nav__group-items">
                    {shown.map((item) => (
                      <div key={item.id}>{destination(page(item), onEntryMenu)}</div>
                    ))}
                  </div>
                </div>
              ))}</div>
            );
          })}
        </div>

        <footer className="studio-nav__footer">
          {/* The light/dark control on a phone. The interface's brightness is a SKIN here
              (`studio-light` / `studio-oled`, see lib/skins.ts) rather than a CSS theme, so the canonical
              control is the same `SkinSwitcher` the TopBar mounts — not a second switch with its own
              state. Drawer only: on a desktop column the TopBar already carries it, and two copies of one
              control on screen is how they drift out of step. It renders nothing when the instance allows
              fewer than two skins, so an operator who never enabled switching sees no dead affordance. */}
          {drawer ? <SkinSwitcher /> : null}
          {adminEntries.map((entry, slot) => (
            <div key={entry.id ?? entry.label}>{entryShell(entry, 'footer', slot, destination(entry, entryMenu(entry)))}</div>
          ))}
          {/* The user block, plus the keyboard's way into the menu the right-click opens. That control
              has to exist independently of the entries: hide them all and there is nothing left to open
              a menu ON. */}
          <div className="studio-nav__user">
            {userEntry ? destination(userEntry, entryMenu(userEntry), (
              <>
                {/* The avatar replaces the entry's glyph in BOTH modes: folded, a face is what makes the
                    bottom of an icon column readable as "you" rather than as one more destination. */}
                {user
                  ? <Avatar user={user} size={24} />
                  : <span className="studio-nav__item-icon"><userEntry.icon size={18} strokeWidth={1.5} /></span>}
                <span className="studio-nav__user-identity" aria-hidden={compact || undefined}>
                  <span className="studio-nav__user-name">{user ? (user.name || user.username) : t.common.daemon}</span>
                  {user?.name ? <span className="studio-nav__user-meta">{user.username}</span> : null}
                </span>
              </>
            )) : null}
            <button
              type="button"
              className="studio-nav__trigger overlay-touch-target"
              aria-label={t.nav.showHidden}
              title={t.nav.showHidden}
              onClick={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                customization.openSurfaceMenu(box.left + box.width / 2, box.top);
              }}
            >
              <MoreHorizontal size={18} strokeWidth={1.5} aria-hidden />
            </button>
          </div>
        </footer>
      </nav>
      {customization.overlays}
    </>
  );
}
