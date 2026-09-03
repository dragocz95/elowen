'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, ChevronsUpDown, MoreHorizontal, Search, Settings2, UserRound, X } from 'lucide-react';
import { useBrand } from '../../lib/brand';
import { useHealth, useMe, usePulse } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { Avatar } from '../ui/Avatar';
import { SkinSwitcher } from '../ui/SkinSwitcher';
import { useShellNavigation } from './useShellNavigation';
import { useNavCustomization } from './NavCustomization';
import { navOrderIndex } from './navOrder';
import { entryIsActive, type NavEntry } from './navEntry';
import { COMMAND_PALETTE_OPEN_EVENT } from './CommandPalette';
import { Dialog, DialogContent, DialogOverlay } from '../ui/shadcn/dialog';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/shadcn/collapsible';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/shadcn/dropdown-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
} from '../ui/shadcn/sidebar';
import { useReturnFocus } from '../ui/overlayStack';

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

/** The drawer mounts on open so the shared return-focus helper captures the actual hamburger. Radix owns
 *  modality, background aria isolation, Escape and the focus trap; this wrapper only supplies the opener
 *  because the shell has no `Dialog.Trigger` for Radix to remember. */
function StudioNavigationDialog({ children, label, onClose, returnFocusTo }: { children: React.ReactElement; label: string; onClose?: () => void; returnFocusTo: HTMLElement | null }) {
  const { restoreFocus } = useReturnFocus();
  const restoreDrawerFocus = useCallback(() => {
    if (returnFocusTo?.isConnected && !returnFocusTo.inert && !returnFocusTo.closest('[inert]')) {
      returnFocusTo.focus({ preventScroll: true });
      return;
    }
    restoreFocus();
  }, [restoreFocus, returnFocusTo]);
  // The shell may close by changing the controlled prop directly (route arrival, close button), bypassing
  // Radix's close event. A layout cleanup runs before the surface leaves the DOM and restores only when
  // focus is still inside it; focus the user moved elsewhere remains theirs.
  useLayoutEffect(() => () => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('[data-testid="studio-navigation"]')) restoreDrawerFocus();
  }, [restoreDrawerFocus]);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose?.(); }}>
      <DialogOverlay presentation="sheet" layer="drawer" className="studio-nav__scrim" data-open>
        <DialogContent
          asChild
          presentation={null}
          aria-label={label}
          aria-labelledby={undefined}
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreDrawerFocus();
          }}
        >
          {children}
        </DialogContent>
      </DialogOverlay>
    </Dialog>
  );
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
export function StudioNavigation({ compact = false, measured = true, side = 'left', onToggleCollapse, drawer = false, drawerOpen = false, onDrawerClose }: {
  compact?: boolean;
  measured?: boolean;
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
  const entryRefs = useRef(new Map<string, HTMLElement>());
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
  const onEntryPointerDown = (event: React.PointerEvent<HTMLElement>, entry: NavEntry, region: DragRegion, slot: number) => {
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
    // `SidebarMenuItem` is shadcn's row wrapper (an <li> inside `SidebarMenu`'s <ul>), which is also
    // what gives the column a real list semantic it used to fake with nested divs. The drag contract is
    // unchanged and still lives here: the shell owns MOVEMENT, the destination inside owns its paint.
    // `--stagger` is the row's index, read by the entrance animation in app/styles/animations.css.
    return (
      <SidebarMenuItem
        ref={(element: HTMLLIElement | null) => { if (id && element) entryRefs.current.set(id, element); else if (id) entryRefs.current.delete(id); }}
        className="studio-nav__entry-shell animate-rise-in"
        data-nav-entry-id={id}
        data-dragging={moving || undefined}
        style={{ ...(shift ? { transform: `translateY(${shift}px)` } : null), '--stagger': slot } as React.CSSProperties}
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
      </SidebarMenuItem>
    );
  };

  // Which groups the reader has folded shut. Groups start open — a sidebar that hides its destinations
  // by default makes the reader work to find out what exists — so this only ever records a deliberate
  // close, and an id absent from it is open.
  const [closedGroups, setClosedGroups] = useState<Record<string, boolean>>({});
  const toggleGroup = (id: string) => setClosedGroups((current) => ({ ...current, [id]: !current[id] }));

  // Arriving somewhere is the end of navigating, so the sheet gets out of the way on its own. The close
  // callback is an unstable inline prop from the shell — deliberately not a dependency.
  useEffect(() => { if (drawer) onDrawerClose?.(); }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const drawerReturnFocusRef = useRef<HTMLElement | null>(null);
  const previousDrawerOpenRef = useRef(false);
  if (drawer && drawerOpen && !previousDrawerOpenRef.current && typeof document !== 'undefined') {
    drawerReturnFocusRef.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null;
  }
  previousDrawerOpenRef.current = drawerOpen;
  const mode = drawer ? 'drawer' : compact ? 'rail' : 'full';
  const user = me.data?.user;

  /** Live counts, keyed by the entry id they annotate. The instance pulse is a SHARED react-query key —
   *  the dashboard and the presence hook already read it — so the badge costs no request of its own on
   *  any page that shows figures, and one refresh moves both. Zero is not a badge: a row that
   *  permanently wears a "0" is noise the reader learns to stop seeing. */
  // `totals` is optional in practice even though the type calls it required: a rollup the daemon could
  // not compute answers without it, and the dashboard already has a regression test for exactly that
  // payload. A badge is not worth taking the whole navigation column down for.
  const runningAgents = usePulse().data?.totals?.runningAgents ?? 0;
  const counters = useMemo<Record<string, { count: number; title: string; live?: boolean }>>(
    () => (runningAgents > 0
      ? { chat: { count: runningAgents, title: `${t.nav.runningAgents}: ${runningAgents}`, live: true } }
      : {} as Record<string, { count: number; title: string; live?: boolean }>),
    [runningAgents, t.nav.runningAgents],
  );

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
    // A live count riding on the row it belongs to. It is `aria-hidden` and carries no accessible name
    // of its own on purpose: the row is addressed by the destination it leads to ("Chat"), and folding a
    // changing number into that name would rename the menu item every time an agent starts or stops —
    // for a screen reader, a different destination each minute. The number is stated in the row's
    // `title` instead, where it is an annotation rather than an identity.
    const badge = entry.id ? counters[entry.id] : undefined;
    return (
      <SidebarMenuButton asChild isActive={active} className="studio-nav__item">
        <Link
          href={entry.href ?? '#'}
          draggable={false}
          aria-current={currentPage ? 'page' : undefined}
          aria-label={named ? entry.label : undefined}
          title={badge ? `${entry.label} · ${badge.title}` : entry.label}
          onContextMenu={onContextMenu}
        >
          {body !== undefined ? <span className="studio-nav__item-body" aria-hidden>{body}</span> : (
            <>
              <span className="studio-nav__item-icon" aria-hidden><Icon size={18} strokeWidth={1.5} /></span>
              <span className="studio-nav__item-label" aria-hidden={compact || undefined}>{entry.label}</span>
            </>
          )}
          {badge ? <SidebarMenuBadge aria-hidden className="studio-nav__badge" data-live={badge.live || undefined}>{badge.count}</SidebarMenuBadge> : null}
        </Link>
      </SidebarMenuButton>
    );
  };

  const entryMenu = (entry: NavEntry) => (entry.id
    ? (event: React.MouseEvent) => customization.onEntryContextMenu(event, entry)
    : customization.onSurfaceContextMenu);

  // `SidebarProvider` is CONTROLLED by the shell's own fold state rather than owning one: the shell
  // measures the workspace and decides between the full column, the icon rail and the sheet, and a
  // second source of truth for "is it folded" is how the rail and the toggle end up disagreeing. Toggling
  // from inside the primitive (SidebarRail) is forwarded to the shell's `onToggleCollapse`.
  //
  // `Sidebar asChild` hands the state attributes to the <nav> the skin already owns, so the primitive
  // contributes its contract (`data-state`, `data-collapsible`, `data-side`) without contributing a
  // second layout. Every part below reads that context.
  const navigation = (
      <Sidebar asChild side={side} collapsible={drawer ? 'none' : 'icon'}>
      <nav
        className={`studio-nav${drawer ? ' overlay-layer-nav-drawer overlay-nav-drawer' : ''}`}
        data-testid="studio-navigation"
        data-mode={mode}
        data-measured={measured}
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
            onClick={() => {
              const target = drawerReturnFocusRef.current;
              onDrawerClose?.();
              queueMicrotask(() => {
                if (target?.isConnected && !target.inert && !target.closest('[inert]')) target.focus({ preventScroll: true });
              });
            }}
            aria-label={t.common.close}
            className="studio-nav__close overlay-touch-target"
          >
            <X size={18} strokeWidth={1.5} aria-hidden />
          </button>
        ) : null}

        {/* The header is a SWITCHER, not a logo. The mark, the instance name and the build are one
            control that opens the instance menu — the shape Linear and Vercel both use, and the reason
            is practical rather than stylistic: the top-left of a sidebar is where a reader looks to
            answer "which instance am I in", and a passive lockup answers that and then refuses to do
            anything about it. In rail mode the skin drops the name and the build and centres the mark;
            the folded column shows a logo, never a sliced word. */}
        <SidebarHeader className="studio-nav__header">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="studio-nav__switcher" aria-label={t.nav.instanceMenu}>
                <img className="studio-nav__brand-mark" src={iconSrc} alt="" width={20} height={20} />
                <span className="studio-nav__brand-lockup" aria-hidden={compact || undefined}>
                  <span className="studio-nav__brand-name">{appName}</span>
                  {health.data?.version ? <span className="studio-nav__version">{`v${health.data.version}`}</span> : null}
                </span>
                <ChevronsUpDown className="studio-nav__switcher-caret" size={14} aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuLabel className="studio-nav__switcher-title">
                {appName}
                {health.data?.version ? <span className="studio-nav__version">{`v${health.data.version}`}</span> : null}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link href="/account"><UserRound size={15} strokeWidth={1.5} aria-hidden />{t.nav.account}</Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href="/settings"><Settings2 size={15} strokeWidth={1.5} aria-hidden />{t.nav.settings}</Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarHeader>

        {/* The palette's own affordance, in the place a reader reaches for search. It is the SAME event
            the TopBar's glyph and the ⌘K binding dispatch, so there is one palette and one way in — this
            is a second door, not a second search. */}
        <div className="studio-nav__search">
          <button
            type="button"
            className="studio-nav__search-pill"
            onClick={() => window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT))}
            aria-label={t.common.openCommandPalette}
            title={`${t.common.openCommandPalette} · ⌘K`}
            aria-keyshortcuts="Control+K Meta+K"
          >
            <Search size={15} strokeWidth={1.5} aria-hidden />
            <span className="studio-nav__search-label" aria-hidden={compact || undefined}>{t.common.searchSite}</span>
            <kbd className="studio-nav__kbd" aria-hidden>⌘K</kbd>
          </button>
        </div>

        <SidebarContent className="studio-nav__body">
         <SidebarGroup className="studio-nav__section">
          <SidebarGroupLabel className="studio-nav__section-label" aria-hidden={compact || undefined}>{t.nav.sectionWork}</SidebarGroupLabel>
          <SidebarGroupContent>
           <SidebarMenu className="studio-nav__menu">
          {bodyEntries.map((entry, slot) => {
            const pages = groupPages(entry);
            const key = entry.id ?? entry.label;
            const onEntryMenu = entryMenu(entry);
            // Desktop/rail stays primary-only; peer pages move into the shared TopBar. The mobile drawer
            // keeps the nested destinations because that header strip is intentionally hidden there.
            if (!pages || !drawer) return <Fragment key={key}>{entryShell(entry, 'body', slot, destination(entry, onEntryMenu))}</Fragment>;

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
            // Radix `Collapsible` owns the disclosure — `data-state`, `aria-expanded` and the
            // trigger/content wiring — but NOT the whole list. It unmounts its content when closed, and
            // the one rule this group has is that the page the reader is standing on survives the fold.
            // So the pages the fold governs sit in `CollapsibleContent` and the page that must not
            // disappear is rendered beside it, only while the group is shut. Nothing is drawn twice.
            return (
              <Fragment key={key}>{entryShell(entry, 'body', slot, (
                <Collapsible
                  open={!closed}
                  onOpenChange={() => toggleGroup(key)}
                  className="studio-nav__group"
                  data-closed={closed || undefined}
                  data-active={active || undefined}
                >
                  {compact ? null : (
                    <CollapsibleTrigger asChild>
                      <button
                        type="button"
                        className="studio-nav__group-toggle"
                        data-active={active || undefined}
                        onContextMenu={onEntryMenu}
                      >
                        <span className="studio-nav__item-icon" aria-hidden><Icon size={18} strokeWidth={1.5} /></span>
                        <span className="studio-nav__item-label">{entry.label}</span>
                        <ChevronRight className="studio-nav__chevron" size={14} aria-hidden />
                      </button>
                    </CollapsibleTrigger>
                  )}
                  <div className="studio-nav__group-items">
                    {closed
                      ? shown.map((item) => <Fragment key={item.id}>{destination(page(item), onEntryMenu)}</Fragment>)
                      : (
                        <CollapsibleContent>
                          {pages.map((item) => <Fragment key={item.id}>{destination(page(item), onEntryMenu)}</Fragment>)}
                        </CollapsibleContent>
                      )}
                  </div>
                </Collapsible>
              ))}</Fragment>
            );
          })}
           </SidebarMenu>
          </SidebarGroupContent>
         </SidebarGroup>
        </SidebarContent>

        <SidebarFooter className="studio-nav__footer">
          {/* The light/dark control on a phone. The interface's brightness is a SKIN here
              (`studio-light` / `studio-oled`, see lib/skins.ts) rather than a CSS theme, so the canonical
              control is the same `SkinSwitcher` the TopBar mounts — not a second switch with its own
              state. Drawer only: on a desktop column the TopBar already carries it, and two copies of one
              control on screen is how they drift out of step. It renders nothing when the instance allows
              fewer than two skins, so an operator who never enabled switching sees no dead affordance. */}
          {drawer ? <SkinSwitcher placement="drawer" /> : null}
          <SidebarGroup className="studio-nav__section">
            <SidebarGroupLabel className="studio-nav__section-label" aria-hidden={compact || undefined}>{t.nav.sectionInstance}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="studio-nav__menu">
                {adminEntries.map((entry, slot) => (
                  <Fragment key={entry.id ?? entry.label}>{entryShell(entry, 'footer', slot, destination(entry, entryMenu(entry)))}</Fragment>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
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
        </SidebarFooter>
        {/* The fold's edge affordance — a hairline target down the column's inner rule, the way Linear
            and Vercel both offer it. Only where folding is the user's call: `onToggleCollapse` is absent
            in the sheet and in a window already forced to the icon column, and a control that changes
            nothing is worse than no control. */}
        {onToggleCollapse ? <SidebarRail className="studio-nav__rail" /> : null}
        {/* Shadcn menus are intentionally not portalled. In drawer mode they must remain descendants of
            Radix Content so its FocusScope and DismissableLayer treat them as part of the active dialog. */}
        {drawer ? customization.overlays : null}
      </nav>
      </Sidebar>
  );

  // The provider wraps BOTH branches rather than the column, and that placement is load-bearing: as a
  // sheet the column is handed to `DialogContent asChild`, which needs a single element it can take a
  // ref on. `Sidebar asChild` renders exactly the <nav>; a provider inside would have put a wrapper div
  // between Radix and the surface it is trapping focus in.
  return (
    <SidebarProvider open={!compact} onOpenChange={() => onToggleCollapse?.()}>
      {drawer && drawerOpen ? (
        <StudioNavigationDialog label={t.common.primaryNav} onClose={onDrawerClose} returnFocusTo={drawerReturnFocusRef.current}>
          {navigation}
        </StudioNavigationDialog>
      ) : navigation}
      {drawer ? null : customization.overlays}
    </SidebarProvider>
  );
}
