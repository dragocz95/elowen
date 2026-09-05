'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, ChevronsUpDown, MoreHorizontal, PanelLeft, Search, Settings2, UserRound, X } from 'lucide-react';
import { useBrand } from '../../lib/brand';
import { useBrainSessions, useHealth, useMe } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { SkinSwitcher } from '../ui/SkinSwitcher';
import { useShellNavigation } from './useShellNavigation';
import { useNavCustomization } from './NavCustomization';
import { navOrderIndex } from './navOrder';
import { entryIsActive, type NavEntry } from './navEntry';
import { sidebarLayout, subMenuPages, type SidebarGroupId } from './navGroups';
import { useSidebarRoute } from './useSidebarRoute';
import { useOpenSubMenus } from './useOpenSubMenus';
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
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from '../ui/shadcn/sidebar';
import { useReturnFocus } from '../ui/overlayStack';

/** The app's primary navigation: one column, built from the shadcn Sidebar primitive and arranged like
 *  the reference dashboard measured in `plans/cloudflare-sidebar-spec.md`.
 *
 *  Top to bottom: a header naming the instance and opening its menu, the command palette's own row, the
 *  destinations in labelled groups with inline accordion sub-menus, the account alone at the end with air
 *  above it rather than a rule, and a footer holding the fold.
 *
 *  This component paints NOTHING. It states what each part IS (`sidebar-nav__*`) and what state it is in
 *  (`data-mode`, `data-open`, `data-active`, `data-ready`); every dimension, hairline and state colour
 *  lives in `app/styles/components/sidebar-nav.css`, driven by the `--sidebar-*` tokens. That split is
 *  what lets a skin retune the column by overriding tokens instead of out-specifying utility classes.
 *
 *  ICONS: lucide at 16px, `strokeWidth` 1.75, dimmed by the stylesheet — the set the whole app and every
 *  plugin already draw from (`lib/pluginIcons.ts` maps a plugin's declared icon name onto it). The
 *  reference uses Phosphor; adopting it here would mean a second icon vocabulary in the same column and
 *  plugin-declared icons that no longer resolve, which is a worse result than a 0.25px stroke difference.
 *  The spec permits either, and asks only that ONE set is used. */

const DRAG_THRESHOLD = 5;

type DragRegion = SidebarGroupId;
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

/** Which half of `aria-keyshortcuts="Control+K Meta+K"` this machine actually uses.
 *
 *  The binding accepts both modifiers everywhere, so the ARIA value names both; the VISIBLE hint may only
 *  name one, and naming the wrong one is a hint that teaches the reader a shortcut their keyboard does
 *  not have. `⌘K` on Apple hardware, `Ctrl K` on everything else. */
function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
    ?? navigator.platform
    ?? '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** The drawer mounts on open so the shared return-focus helper captures the actual hamburger. Radix owns
 *  modality, background aria isolation, Escape and the focus trap; this wrapper only supplies the opener
 *  because the shell has no `Dialog.Trigger` for Radix to remember. */
function SidebarNavSheet({ children, label, onClose, returnFocusTo }: { children: React.ReactElement; label: string; onClose?: () => void; returnFocusTo: HTMLElement | null }) {
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
    if (active instanceof HTMLElement && active.closest('[data-testid="sidebar-navigation"]')) restoreDrawerFocus();
  }, [restoreDrawerFocus]);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose?.(); }}>
      <DialogOverlay presentation="sheet" layer="drawer" className="sidebar-nav__scrim" data-open>
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

export function SidebarNav({ compact = false, measured = true, side = 'left', onToggleCollapse, drawer = false, drawerOpen = false, onDrawerClose }: {
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
  const { groups, account } = useMemo(() => sidebarLayout(sequence), [sequence]);
  // THIS surface's own visible order, which is what the first edit seeds the stored order from. Handing
  // over the registry order instead would reshuffle the column the moment anything was hidden or moved.
  const displayOrder = useMemo(
    () => [...groups.flatMap((group) => [...group.entries]), ...(account ? [account] : [])]
      .flatMap((entry) => (entry.id ? [entry.id] : [])),
    [groups, account],
  );
  const customization = useNavCustomization(allWorlds, layout, displayOrder);

  // Where the reader is, answered once for the whole column: the section that paints as the current
  // place, the one row that carries `aria-current`, and the sub-menu that must be open to show it.
  const route = useSidebarRoute(sequence);
  const userId = me.data?.user?.id ?? null;
  const subMenus = useOpenSubMenus(userId, drawer || !compact ? route.openId : undefined);

  // Desktop keeps the direct-manipulation contract the column has always had: hold the primary pointer
  // and move a row. Touch remains scrolling (and uses the context menu's keyboard-equivalent move
  // actions), while the sheet never rearranges underneath a finger trying to dismiss or navigate it.
  const entryRefs = useRef(new Map<string, HTMLElement>());
  const pressRef = useRef<DragPress | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const [drag, setDrag] = useState<DragState | null>(null);

  const regionEntries = useCallback(
    (region: DragRegion): readonly NavEntry[] => groups.find((group) => group.id === region)?.entries ?? [],
    [groups],
  );
  const releaseDrag = useCallback(() => {
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
  }, []);
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
    // A stored layout interleaves entries this column presents in separate groups. `reorderNavEntry`
    // consumes an index in THAT persisted visible order, not in this surface's partition. On the first
    // edit there is no persisted order yet, so the surface order is the only truthful seed.
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
  }, [releaseDrag]);

  // Arriving somewhere is the end of navigating, so the sheet gets out of the way on its own. The close
  // callback is an unstable inline prop from the shell — deliberately not a dependency.
  useEffect(() => { if (drawer) onDrawerClose?.(); }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  // The fold is a desktop affordance, so the shortcut exists exactly where the control does:
  // `onToggleCollapse` is absent in the sheet and in a window already forced to the icon column, where
  // it could change nothing.
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

  /** Live counts, keyed by the entry id they annotate. Zero is not a badge: a row that permanently wears
   *  a "0" is noise the reader learns to stop seeing.
   *
   *  The Chat count is the reader's OWN busy conversations, read from the conversation list the chat rail
   *  already holds under a SHARED react-query key — so the badge costs no request of its own wherever
   *  that list is on screen, and the owner-scoped `conversations` SSE moves both (see useElowenEvents). */
  const sessions = useBrainSessions();
  const workingConversations = useMemo(
    () => (sessions.data ?? []).filter((session) => session.working === true).length,
    [sessions.data],
  );
  const counters = useMemo<Record<string, { count: number; title: string; live?: boolean }>>(
    () => (workingConversations > 0
      ? { chat: { count: workingConversations, title: `${t.nav.workingConversations}: ${workingConversations}`, live: true } }
      : {} as Record<string, { count: number; title: string; live?: boolean }>),
    [workingConversations, t.nav.workingConversations],
  );

  // Resolved AFTER mount, never during render: the server has no navigator, so deriving this inline
  // would make the first client render disagree with the markup it is hydrating.
  const [paletteHint, setPaletteHint] = useState('Ctrl K');
  useEffect(() => { if (isApplePlatform()) setPaletteHint('⌘K'); }, []);

  const entryMenu = (entry: NavEntry) => (entry.id
    ? (event: React.MouseEvent) => customization.onEntryContextMenu(event, entry)
    : customization.onSurfaceContextMenu);

  /** The row wrapper: shadcn's `<li>`, plus the drag contract. The shell owns MOVEMENT, the row inside
   *  owns its own paint. `--stagger` is the row's index, read by the entrance animation. */
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
      <SidebarMenuItem
        ref={(element: HTMLLIElement | null) => { if (id && element) entryRefs.current.set(id, element); else if (id) entryRefs.current.delete(id); }}
        className="sidebar-nav__entry animate-rise-in"
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

  /** A destination row at the top level.
   *
   *  The label stays mounted so the collapse transition can finish, but is `aria-hidden` in the icon
   *  column; `aria-label` names the row exactly where the text is not presented.
   *
   *  The two hover hints do not overlap. EXPANDED the row carries the native `title`, which is there to
   *  keep a truncated label readable and is exactly the right affordance for it. FOLDED the label is not
   *  on screen at all, so the primitive's `tooltip` names the glyph in a real, styled tip beside the rail
   *  — a native `title` there is a 500ms delay and an OS bubble the design has no say over. */
  const destination = (entry: NavEntry, onContextMenu?: (event: React.MouseEvent) => void) => {
    const active = entryIsActive(entry, pathname);
    const currentPage = active && entry.href !== undefined && route.currentHref === entry.href;
    const Icon = entry.icon;
    const badge = entry.id ? counters[entry.id] : undefined;
    const hint = badge ? `${entry.label} · ${badge.title}` : entry.label;
    return (
      <SidebarMenuButton asChild isActive={active} className="sidebar-nav__item" tooltip={hint}>
        <Link
          href={entry.href ?? '#'}
          draggable={false}
          aria-current={currentPage ? 'page' : undefined}
          aria-label={compact ? entry.label : undefined}
          title={compact ? undefined : hint}
          onContextMenu={onContextMenu}
        >
          <span className="sidebar-nav__icon" aria-hidden><Icon size={16} strokeWidth={1.75} /></span>
          <span className="sidebar-nav__label" aria-hidden={compact || undefined}>{entry.label}</span>
          {badge ? <SidebarMenuBadge aria-hidden className="sidebar-nav__badge" data-live={badge.live || undefined}>{badge.count}</SidebarMenuBadge> : null}
        </Link>
      </SidebarMenuButton>
    );
  };

  /** A row that discloses its pages inline instead of leading anywhere itself.
   *
   *  The parent is a BUTTON, not a link: every page of the group is a row inside it, including the one
   *  the entry's own `href` points at, so there is nothing left for the parent to navigate to. Radix
   *  `Collapsible` owns `aria-expanded`, the trigger/content wiring and the open/closed data attributes;
   *  the stylesheet animates the disclosure from them. */
  const subMenu = (entry: NavEntry, pages: NonNullable<NavEntry['subItems']>, onContextMenu?: (event: React.MouseEvent) => void) => {
    const key = entry.id ?? entry.label;
    const active = entryIsActive(entry, pathname);
    const open = subMenus.isOpen(key);
    const Icon = entry.icon;
    return (
      <Collapsible open={open} onOpenChange={() => subMenus.toggle(key)} className="sidebar-nav__disclosure">
        <CollapsibleTrigger asChild>
          <SidebarMenuButton isActive={active} className="sidebar-nav__item" title={entry.label} tooltip={entry.label} onContextMenu={onContextMenu}>
            <span className="sidebar-nav__icon" aria-hidden><Icon size={16} strokeWidth={1.75} /></span>
            <span className="sidebar-nav__label">{entry.label}</span>
            <ChevronRight className="sidebar-nav__caret" size={12} strokeWidth={1.75} aria-hidden />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub className="sidebar-nav__sub">
            {pages.map((page) => {
              const PageIcon = page.icon;
              const current = route.currentHref === page.href;
              return (
                <SidebarMenuSubItem key={page.id}>
                  <SidebarMenuSubButton asChild isActive={current} className="sidebar-nav__sub-item">
                    <Link href={page.href} draggable={false} aria-current={current ? 'page' : undefined} title={page.label} onContextMenu={onContextMenu}>
                      {PageIcon ? <span className="sidebar-nav__icon" aria-hidden><PageIcon size={16} strokeWidth={1.75} /></span> : null}
                      <span className="sidebar-nav__label">{page.label}</span>
                    </Link>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              );
            })}
          </SidebarMenuSub>
        </CollapsibleContent>
      </Collapsible>
    );
  };

  /** What a row IS: a destination, or a disclosure over the pages of one. The icon column has no room for
   *  a disclosure, so a sub-menu there collapses to its parent destination and every page stays one click
   *  away through it. */
  const rowBody = (entry: NavEntry) => {
    const pages = subMenuPages(entry);
    const onMenu = entryMenu(entry);
    return pages && !compact ? subMenu(entry, pages, onMenu) : destination(entry, onMenu);
  };

  const row = (entry: NavEntry, region: DragRegion, slot: number) => (
    <Fragment key={entry.id ?? entry.label}>{entryShell(entry, region, slot, rowBody(entry))}</Fragment>
  );

  const groupLabel = (id: SidebarGroupId): string | null => {
    if (id === 'work') return t.nav.sectionWork;
    if (id === 'instance') return t.nav.sectionInstance;
    // The first block is where the reader lands. A header over it names nothing its two rows do not.
    return null;
  };

  // `SidebarProvider` is CONTROLLED by the shell's own fold state rather than owning one: the shell
  // measures the workspace and decides between the full column, the icon rail and the sheet, and a
  // second source of truth for "is it folded" is how the rail and the toggle end up disagreeing.
  //
  // `Sidebar asChild` hands the state attributes to the <nav> the stylesheet already owns, so the
  // primitive contributes its contract (`data-state`, `data-collapsible`, `data-side`) without
  // contributing a second layout. Every part below reads that context.
  const navigation = (
    <Sidebar asChild side={side} collapsible={drawer ? 'none' : 'icon'}>
      <nav
        className={`sidebar-nav${drawer ? ' overlay-layer-nav-drawer overlay-nav-drawer' : ''}`}
        data-testid="sidebar-navigation"
        // The stable hook a SKIN targets this column by. `data-testid` is a test handle and `sidebar-nav`
        // is one design's own class, so neither is something a third-party skin should select on; this
        // attribute names the ROLE the element plays in the shell and survives a restyle of either.
        data-shell="sidebar"
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
            className="sidebar-nav__close overlay-touch-target"
          >
            <X size={18} strokeWidth={1.75} aria-hidden />
          </button>
        ) : null}

        {/* The header is a SWITCHER, not a logo. The mark, the instance name and the build are one
            control that opens the instance menu — the top-left of a sidebar is where a reader looks to
            answer "which instance am I in", and a passive lockup answers that and then refuses to do
            anything about it. In rail mode the stylesheet drops the name and centres the mark. */}
        <SidebarHeader className="sidebar-nav__header">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="sidebar-nav__switcher" aria-label={t.nav.instanceMenu}>
                <img className="sidebar-nav__mark" src={iconSrc} alt="" width={28} height={28} />
                <span className="sidebar-nav__lockup" aria-hidden={compact || undefined}>
                  <span className="sidebar-nav__brand">{appName}</span>
                  {health.data?.version ? <span className="sidebar-nav__version">{`v${health.data.version}`}</span> : null}
                </span>
                <ChevronsUpDown className="sidebar-nav__switcher-caret" size={12} strokeWidth={1.75} aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuLabel className="sidebar-nav__switcher-title">
                {appName}
                {health.data?.version ? <span className="sidebar-nav__version">{`v${health.data.version}`}</span> : null}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link href="/account"><UserRound size={15} strokeWidth={1.75} aria-hidden />{t.nav.account}</Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href="/settings"><Settings2 size={15} strokeWidth={1.75} aria-hidden />{t.nav.settings}</Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarHeader>

        {/* The palette's own affordance, in the place a reader reaches for search. It is the SAME event
            the TopBar's glyph and the ⌘K binding dispatch, so there is one palette and one way in — this
            is a second door, not a second search. */}
        <div className="sidebar-nav__search">
          <button
            type="button"
            className="sidebar-nav__search-field"
            onClick={() => window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT))}
            aria-label={t.common.openCommandPalette}
            title={`${t.common.openCommandPalette} · ${paletteHint}`}
            aria-keyshortcuts="Control+K Meta+K"
          >
            <Search size={16} strokeWidth={1.75} aria-hidden />
            <span className="sidebar-nav__search-label" aria-hidden={compact || undefined}>{t.common.searchSite}</span>
            <kbd className="sidebar-nav__kbd" aria-hidden>{paletteHint}</kbd>
          </button>
        </div>

        <SidebarContent className="sidebar-nav__body">
          {groups.map((group) => {
            const label = groupLabel(group.id);
            return (
              <SidebarGroup key={group.id} className="sidebar-nav__group" data-group={group.id}>
                {label ? <SidebarGroupLabel className="sidebar-nav__group-label" aria-hidden={compact || undefined}>{label}</SidebarGroupLabel> : null}
                <SidebarGroupContent>
                  <SidebarMenu className="sidebar-nav__menu">
                    {group.entries.map((entry, slot) => row(entry, group.id, slot))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            );
          })}
          {/* The account sits alone at the end, set apart by AIR and by nothing else — the reference's
              "Manage account", and no hairline above it (owner decision, 5 Sep 2026). It is still an
              ordinary entry: the same context menu hides, restores and reorders it, and it discloses its
              own sections exactly like every other row. Only the region it is drawn in is fixed, which is
              why it is built from `rowBody` rather than from a link: the account page is a deck, and
              drawing it as a plain destination is what would leave its sections with no way in at all. */}
          {account ? (
            <SidebarGroup className="sidebar-nav__group" data-group="account">
              <SidebarGroupContent>
                <SidebarMenu className="sidebar-nav__menu">
                  <SidebarMenuItem className="sidebar-nav__entry" data-nav-entry-id={account.id}>
                    {rowBody(account)}
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ) : null}
        </SidebarContent>

        <SidebarFooter className="sidebar-nav__footer">
          {/* The light/dark control on a phone. The interface's brightness is a SKIN here
              (`studio-light` / `studio-oled`, see lib/skins.ts) rather than a CSS theme, so the canonical
              control is the same `SkinSwitcher` the TopBar mounts — not a second switch with its own
              state. Sheet only: on a desktop column the TopBar already carries it. */}
          {drawer ? <SkinSwitcher placement="drawer" /> : null}
          {/* The fold, bottom-left, exactly where the reference puts it. `SidebarTrigger` toggles the
              primitive's own state, which this column forwards to the shell. Offered only where folding
              is the user's call — a control that changes nothing is worse than no control. */}
          {onToggleCollapse ? (
            <SidebarTrigger
              className="sidebar-nav__collapse"
              data-testid="sidebar-nav-collapse"
              aria-label={compact ? t.common.expandNav : t.common.collapseNav}
              title={`${compact ? t.common.expandNav : t.common.collapseNav} · ${t.nav.collapseShortcut}`}
              aria-keyshortcuts="Control+Backslash Meta+Backslash"
            >
              <PanelLeft size={16} strokeWidth={1.75} aria-hidden />
            </SidebarTrigger>
          ) : null}
          {/* The keyboard's way into the menu the right-click opens. It has to exist independently of the
              entries: hide them all and there is nothing left to open a menu ON. */}
          <button
            type="button"
            className="sidebar-nav__more overlay-touch-target"
            aria-label={t.nav.showHidden}
            title={t.nav.showHidden}
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              customization.openSurfaceMenu(box.left + box.width / 2, box.top);
            }}
          >
            <MoreHorizontal size={16} strokeWidth={1.75} aria-hidden />
          </button>
        </SidebarFooter>
        {/* The fold's edge affordance — a hairline target down the column's inner rule, the way Linear
            and Vercel both offer it. */}
        {onToggleCollapse ? <SidebarRail className="sidebar-nav__rail" /> : null}
        {/* Shadcn menus are intentionally not portalled. In sheet mode they must remain descendants of
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
        <SidebarNavSheet label={t.common.primaryNav} onClose={onDrawerClose} returnFocusTo={drawerReturnFocusRef.current}>
          {navigation}
        </SidebarNavSheet>
      ) : navigation}
      {drawer ? null : customization.overlays}
    </SidebarProvider>
  );
}
