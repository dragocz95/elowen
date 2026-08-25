'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type WheelEvent } from 'react';
import { ChevronDown, MoreHorizontal } from 'lucide-react';
import { useHealth } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { useShellNavigation } from './useShellNavigation';
import { useNavCustomization } from './NavCustomization';
import { CollapseHandle } from './CollapseHandle';
import { EmberFall } from './EmberFall';
import { useElementHeight } from '../../lib/useElementWidth';
import { entryIsActive, type NavEntry } from './navEntry';

/** Top to bottom: where you land, then project context and automation, then administration.
 *  This is only the untouched default; a user's own arrangement overrides it entirely. Unknown plugin
 *  worlds stay dynamic and fall after the named platform integrations rather than being special-cased. */
const SPATIAL_ROUTE_ORDER = [
  '/dash', '/chat',
  '/projects', '/p/editor',
  '/p/subagent', '/p/cronjob', '/p/skills',
  '/memory', '/p/stats',
  '/account', '/users', '/settings',
];
/** Where an entry parks on the axis. Prefix matching lets a plugin's nested pages share its slot; an
 *  unmatched dynamic plugin falls after the administration block. */
function spatialOrderIndex(href: string | undefined): number {
  if (!href) return Number.MAX_SAFE_INTEGER;
  const index = SPATIAL_ROUTE_ORDER.findIndex((route) => href === route || href.startsWith(`${route}/`));
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}
/** Whether the axis names this page by its own address rather than through its world. That is what
 *  decides which worlds the rail opens up: a world whose pages have their own slots contributes those
 *  pages (the work register, the board, the timeline, the spend stats each own one), and every other
 *  world contributes its face. The order above is the single place that says so — before, the two
 *  expanded worlds were hardcoded by id here, which stopped being expressible the moment a world could
 *  arrive from a plugin. */
function isAxisPage(href: string | undefined): boolean {
  return href !== undefined && SPATIAL_ROUTE_ORDER.includes(href);
}

/** A rail destination plus the world it came from, which is the unit the navigation layout addresses. */
type RailEntry = NavEntry & { worldId?: string; worldIndex?: number };

/** A world being carried to a new place: where it started, where it would land, and how far the pointer
 *  has moved. Nothing is committed until the pointer is released. */
type RailDrag = { worldId: string; from: number; to: number; dy: number };

/** A pointer resting on a destination, before it is known whether this is a click, a drag or a hold. */
type RailPress = {
  worldId: string;
  slot: number;
  startY: number;
  pointerId: number;
  pointerType: string;
  /** Where the axis stood when the finger landed, so a touch scroll is absolute rather than cumulative. */
  startOffset: number;
  element: HTMLElement;
  longPress?: number;
};

/** How far the pointer must travel before it counts as carrying the entry rather than clicking it. */
const DRAG_THRESHOLD = 6;
/** How long a finger has to rest before a press becomes a menu rather than a tap or a scroll. */
const LONG_PRESS_MS = 500;

/** The public site's rail spacing — the look this rail matches. */
const SPACING = 66;
/** Vertical room the largest (active) node needs, so the end destinations never clip. It is the
 *  diameter of the active node (4.65rem), and it only works because the items are anchored at exactly
 *  half the axis: `getStableOffsets` spreads them symmetrically around the centre, so an anchor even
 *  one percent off centre spends that much of this headroom and clips the first node on a short
 *  screen — which is what a phone is. */
const NODE_HEADROOM = 80;

/** Where each destination is parked on the axis: a fixed, centered order that does NOT depend on which
 *  route is active. Only scale/opacity/blur react to the active route, so the rail never re-shuffles. */
export function getStableOffsets(count: number, spacing: number): number[] {
  const center = (count - 1) / 2;
  return Array.from({ length: count }, (_, index) => (index - center) * spacing);
}

/** Below this the destinations stop being separate things and start being a stripe, so the axis
 *  scrolls instead of tightening any further. */
const MIN_SPACING = 46;

/** The public rail carries 8 destinations at SPACING; this one carries more, which overflows a
 *  laptop-height axis. Keep SPACING wherever it fits and otherwise tighten — but only down to a
 *  legible floor. Past that the answer is to move the axis, not to crush it. */
export function railSpacing(count: number, stageHeight: number): number {
  if (stageHeight <= 0 || count < 2) return SPACING;
  return Math.min(SPACING, Math.max(MIN_SPACING, (stageHeight - NODE_HEADROOM) / (count - 1)));
}

/** How far the axis may travel in each direction. */
function railScrollRange(count: number, spacing: number, stageHeight: number): number {
  if (stageHeight <= 0 || count < 2) return 0;
  const span = (count - 1) * spacing + NODE_HEADROOM;
  return Math.max(0, (span - stageHeight) / 2);
}

/** A straight spatial axis. The active route is always the largest node; surrounding destinations
 *  recede in place — they never slide past each other or wrap around the ends.
 *
 *  `onToggleCollapse` is what puts the collapse handle on the edge. It is absent whenever collapsing is
 *  not the user's call — a window too narrow for the full rail is already forced compact, and a handle
 *  that cannot change anything is worse than no handle at all. */
export function OrbitalNav({ compact = false, side = 'left', onToggleCollapse, drawer = false, drawerOpen = false, onDrawerClose }: {
  compact?: boolean;
  side?: 'left' | 'right';
  onToggleCollapse?: () => void;
  /** On a phone the rail slides in over the content instead of holding a column of its own. Same rail,
   *  same order, same editor — only the way it claims room differs, so there is one menu to learn.
   *  It deliberately stops short of the full width: the strip of backdrop left showing is both the
   *  signal that this is a layer over the page and the target that dismisses it. */
  drawer?: boolean;
  drawerOpen?: boolean;
  onDrawerClose?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { worlds, allWorlds, layout, layoutReady } = useShellNavigation();
  const health = useHealth();
  const { t } = useTranslation();
  const lastWheelAt = useRef(0);
  // `worldId` is what the customization menu acts on: a world can contribute several axis pages, and
  // hiding or moving any of them means hiding or moving the world they belong to. Account, Settings and
  // Users are ordinary worlds here and carry one like everything else.
  const routeEntries = useMemo<RailEntry[]>(() => {
    const all = worlds.flatMap((world, worldIndex) => {
      const pages = (world.subItems ?? []).filter((item) => isAxisPage(item.href));
      const entries: NavEntry[] = pages.length > 0
        ? pages.map((item) => ({ ...item, icon: item.icon ?? world.icon }))
        : [world];
      return entries.map((entry) => ({ ...entry, worldId: world.id, worldIndex }));
    });
    const axisRank = (entry: RailEntry) => spatialOrderIndex(entry.href);
    // An untouched menu keeps the spatial axis, which carries meaning of its own (where you land, the
    // work, what it runs on, administration). Once the user has arranged the menu, their order wins.
    if (layout.order.length === 0) return all.sort((a, b) => axisRank(a) - axisRank(b));
    const worldRank = (entry: RailEntry) => entry.worldIndex ?? Number.MAX_SAFE_INTEGER;
    return all.sort((a, b) => worldRank(a) - worldRank(b) || axisRank(a) - axisRank(b));
  }, [worlds, layout]);
  // The sequence of worlds as the rail presents them, which is what an edit must build the stored order
  // from — otherwise the first hide or move would re-sort the rail into registry order under the user.
  const railWorldOrder = useMemo(() => [...worlds]
    .sort((a, b) => spatialOrderIndex(a.href) - spatialOrderIndex(b.href))
    .flatMap((world) => (world.id ? [world.id] : [])), [worlds]);
  // Until the arrangement is known the rail would paint in registry order and then visibly re-sort
  // itself, on every single page load. Showing nothing for that one frame is the honest option: the
  // menu appears once, already in the right order.
  const customization = useNavCustomization(allWorlds, layout, railWorldOrder);
  // Hold the entrance animation until the arrangement is known: the rail animates every position change,
  // so a layout arriving one frame late would play out as the whole menu sliding into place.
  const [animate, setAnimate] = useState(false);
  useEffect(() => {
    if (!layoutReady || animate) return;
    const frame = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(frame);
  }, [layoutReady, animate]);
  // Arriving somewhere is the end of navigating, so the panel gets out of the way on its own. The
  // close callback is an unstable inline prop from the shell — deliberately not a dependency.
  useEffect(() => { if (drawer) onDrawerClose?.(); }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps
  const activeIndex = Math.max(0, routeEntries.findIndex((entry) => entryIsActive(entry, pathname)));
  const stageRef = useRef<HTMLDivElement>(null);
  const stageHeight = useElementHeight(stageRef);
  const spacing = railSpacing(routeEntries.length, stageHeight);
  const positions = useMemo(
    () => getStableOffsets(routeEntries.length, spacing),
    [routeEntries.length, spacing],
  );

  // How far the axis has been moved from its centred rest position. It only ever leaves zero when the
  // destinations genuinely outgrow the stage.
  const navRef = useRef<HTMLElement | null>(null);
  // An overlay that the keyboard cannot close, and that focus never enters, is a layer only the mouse
  // knows about. Focus goes in on open and returns to whatever opened it on close.
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
    // Only take focus back if it is still inside the drawer; the user may have clicked elsewhere.
    if (navRef.current?.contains(document.activeElement)) returnFocusTo.current?.focus();
    returnFocusTo.current = null;
    return undefined;
  }, [drawer, drawerOpen, onDrawerClose]);

  const [axisOffset, setAxisOffset] = useState(0);
  const scrollRange = railScrollRange(routeEntries.length, spacing, stageHeight);
  const clampAxis = (value: number) => Math.max(-scrollRange, Math.min(scrollRange, value));
  // A rail that shrinks (window resize, a space hidden) must not stay parked past its new end.
  useEffect(() => { setAxisOffset((current) => Math.max(-scrollRange, Math.min(scrollRange, current))); }, [scrollRange]);
  // Landing somewhere off-screen and having to hunt for it would be worse than not scrolling at all,
  // so ARRIVING somewhere brings the active destination back to the middle. Keyed on the arrival and
  // nothing else: `scrollRange` is recomputed on every render and a resize observer nudges it, so
  // reacting to it as well would snap the axis back to centre while the user was still scrolling it.
  const centredFor = useRef(-1);
  useEffect(() => {
    if (scrollRange <= 0) { centredFor.current = -1; return; }
    if (centredFor.current === activeIndex) return;
    centredFor.current = activeIndex;
    setAxisOffset(Math.max(-scrollRange, Math.min(scrollRange, -(positions[activeIndex] ?? 0))));
  }, [activeIndex, scrollRange]); // eslint-disable-line react-hooks/exhaustive-deps

  // Where each world sits on the axis. A world can contribute several destinations (the work register,
  // board, timeline and stats are all one world), but it moves as ONE thing, so a drag is expressed in
  // world slots rather than in rail rows.
  const worldSlots = useMemo(() => {
    const seen = new Set<string>();
    return routeEntries.flatMap((entry, index) => {
      if (!entry.worldId || seen.has(entry.worldId)) return [];
      seen.add(entry.worldId);
      return [{ worldId: entry.worldId, index }];
    });
  }, [routeEntries]);

  const [drag, setDrag] = useState<RailDrag | null>(null);
  const dragRef = useRef<RailDrag | null>(null);
  const pressRef = useRef<RailPress | null>(null);
  const suppressClick = useRef(false);

  const clearPress = () => {
    if (pressRef.current?.longPress) window.clearTimeout(pressRef.current.longPress);
    pressRef.current = null;
  };

  // A long press on empty rail opens the surface menu. Touch has no right-click, so without it a
  // phone whose every entry is hidden has no way back — the rail would be blank and inert.
  const surfacePressRef = useRef<number | undefined>(undefined);
  const endSurfacePress = () => {
    if (surfacePressRef.current !== undefined) window.clearTimeout(surfacePressRef.current);
    surfacePressRef.current = undefined;
  };
  const onSurfacePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    endSurfacePress();
    if (event.pointerType !== 'touch') return;
    // A press that landed ON a destination is that entry's gesture, not the surface's.
    if ((event.target as HTMLElement).closest('[role="listitem"]') !== null) return;
    const { clientX, clientY } = event;
    surfacePressRef.current = window.setTimeout(() => {
      surfacePressRef.current = undefined;
      customization.openSurfaceMenu(clientX, clientY);
    }, LONG_PRESS_MS);
  };

  const onEntryPointerDown = (event: React.PointerEvent<HTMLElement>, entry: RailEntry) => {
    if (!entry.worldId || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const slot = worldSlots.findIndex((candidate) => candidate.worldId === entry.worldId);
    if (slot < 0) return;
    // A drag that produced no click (released outside, or a browser that synthesises none) would
    // otherwise leave this armed and swallow the NEXT click — navigation silently stops working.
    // Every fresh press starts from a clean slate.
    suppressClick.current = false;
    pressRef.current = {
      worldId: entry.worldId,
      slot,
      startY: event.clientY,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      startOffset: axisOffset,
      // Capturing the pointer is what lets a drag follow it outside the row, but it also stops the
      // browser synthesising the click on the link inside. So it is taken only once this is KNOWN to
      // be a drag, never on a press that may still turn out to be a plain click.
      element: event.currentTarget,
      // Touch has no right-click, so a press held still opens the same menu a mouse gets. It is armed
      // only for touch: a mouse user holding still is not asking for anything.
      longPress: event.pointerType === 'touch'
        ? window.setTimeout(() => {
            clearPress();
            // The finger is still down. Lifting it makes the browser synthesise a click on the link
            // underneath, which would navigate away from the menu that just opened — and on a phone
            // that also closes the drawer the menu is in.
            suppressClick.current = true;
            customization.openEntryMenu(event.clientX, event.clientY, { ...entry, id: entry.worldId });
          }, LONG_PRESS_MS)
        : undefined,
    };
  };

  const onEntryPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const press = pressRef.current;
    if (!press) return;
    const dy = event.clientY - press.startY;
    // A drag only starts once the pointer has actually travelled, so a plain click still navigates.
    if (!dragRef.current && Math.abs(dy) < DRAG_THRESHOLD) return;
    if (press.longPress) { window.clearTimeout(press.longPress); press.longPress = undefined; }
    // A finger dragging the rail is scrolling it, not rearranging it — one vertical drag cannot mean
    // both. Rearranging by touch goes through the long-press menu.
    if (press.pointerType === 'touch') {
      if (scrollRange > 0) setAxisOffset(clampAxis(press.startOffset + dy));
      return;
    }
    if (!dragRef.current) {
      try { press.element.setPointerCapture(press.pointerId); } catch { /* pointer already gone */ }
    }
    const originY = positions[worldSlots[press.slot].index] ?? 0;
    const carriedY = originY + dy;
    let to = press.slot;
    let nearest = Number.POSITIVE_INFINITY;
    worldSlots.forEach((candidate, index) => {
      const distance = Math.abs((positions[candidate.index] ?? 0) - carriedY);
      if (distance < nearest) { nearest = distance; to = index; }
    });
    const next = { worldId: press.worldId, from: press.slot, to, dy };
    dragRef.current = next;
    setDrag(next);
  };

  /** Release everything a gesture holds. A pointer can end in more ways than `pointerup`: the browser
   *  can cancel it, or take the capture away, and a rail left thinking it is still being dragged
   *  misreads the next press entirely. */
  const releaseGesture = () => {
    const press = pressRef.current;
    if (press && dragRef.current) {
      try { press.element.releasePointerCapture(press.pointerId); } catch { /* already released */ }
    }
    clearPress();
    dragRef.current = null;
    setDrag(null);
  };

  // Losing the capture mid-drag ends the drag: continuing to track a pointer the element no longer
  // receives would leave the rail stuck in its dragging state until the next press.
  const onEntryLostPointerCapture = () => { if (dragRef.current) releaseGesture(); };

  // Nothing may outlive the component: a pending long press would fire into a menu that no longer
  // exists, and an unreleased capture would hold a pointer the rail can no longer see.
  useEffect(() => () => { releaseGesture(); endSurfacePress(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onEntryPointerUp = () => {
    const dragged = dragRef.current;
    const press = pressRef.current;
    if (dragged && press) {
      try { press.element.releasePointerCapture(press.pointerId); } catch { /* already released */ }
    }
    clearPress();
    dragRef.current = null;
    if (!dragged) return;
    setDrag(null);
    // The pointer travelled, so whatever click the browser is about to synthesise was a drag, not a
    // request to navigate.
    suppressClick.current = true;
    if (dragged.to !== dragged.from) customization.reorderTo(dragged.worldId, dragged.to);
  };

  // How far a destination steps aside to open the gap the dragged world will land in. The dragged
  // world's own destinations travel with the pointer instead.
  const shiftOf = (entry: RailEntry): number => {
    if (!drag) return 0;
    if (entry.worldId === drag.worldId) return drag.dy;
    const slot = worldSlots.findIndex((candidate) => candidate.worldId === entry.worldId);
    if (slot < 0) return 0;
    const span = routeEntries.filter((candidate) => candidate.worldId === drag.worldId).length * spacing;
    if (drag.from < drag.to && slot > drag.from && slot <= drag.to) return -span;
    if (drag.from > drag.to && slot < drag.from && slot >= drag.to) return span;
    return 0;
  };

  const onWheel = (event: WheelEvent<HTMLElement>) => {
    if (Math.abs(event.deltaY) < 8 || routeEntries.length === 0) return;
    // With more destinations than fit, the wheel does what a wheel does: it moves the list. Stepping
    // through routes instead would navigate somewhere just to look at the rest of the menu.
    if (scrollRange > 0) {
      event.preventDefault();
      setAxisOffset((current) => clampAxis(current - event.deltaY));
      return;
    }
    event.preventDefault();
    const now = performance.now();
    if (now - lastWheelAt.current < 420) return;
    lastWheelAt.current = now;
    const direction = event.deltaY > 0 ? 1 : -1;
    // Clamped, not wrapped: scrolling past an end stays put rather than teleporting the rail to the
    // far side, which reads as the whole axis jumping.
    const nextIndex = Math.max(0, Math.min(routeEntries.length - 1, activeIndex + direction));
    const next = routeEntries[nextIndex];
    if (next?.href && nextIndex !== activeIndex) router.push(next.href);
  };

  const axis = compact ? '2.2rem' : '2.5rem';

  const hidden = drawer && !drawerOpen;

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
      ref={navRef}
      data-side={side}
      data-testid="future-navigation"
      aria-label={t.common.primaryNav}
      aria-hidden={hidden ? true : undefined}
      inert={hidden ? true : undefined}
      onWheel={onWheel}
      // Anywhere on the rail that is not a destination opens the editor — that is how a hidden space
      // is found again.
      onContextMenu={customization.onSurfaceContextMenu}
      onPointerDown={onSurfacePointerDown}
      onPointerMove={endSurfacePress}
      onPointerUp={endSurfacePress}
      onPointerCancel={endSurfacePress}
      className={`overflow-hidden border-border/45 bg-black ${drawer
        ? `fixed inset-y-0 z-50 w-[min(20rem,85vw)] shadow-2xl transition-transform duration-200 ${side === 'right'
          ? `right-0 border-l ${drawerOpen ? 'translate-x-0' : 'translate-x-full'}`
          : `left-0 border-r ${drawerOpen ? 'translate-x-0' : '-translate-x-full'}`}`
        : `relative h-full shrink-0 ${side === 'right' ? 'border-l' : 'border-r'} ${compact ? 'w-[4.75rem]' : 'w-[17rem]'}`}`}
      style={drawer ? { transitionTimingFunction: 'var(--ease-out)' } : undefined}
    >
      {/* Ambient sparks behind the rail. The nav is already `relative` + `overflow-hidden`, so it is the
          containing block that both sizes and clips them; every item below sits on z-10, above the canvas. */}
      <EmberFall />
      <div
        ref={stageRef}
        role="list"
        data-layout-ready={layoutReady || undefined}
        // Deliberately visual only. Marking the stage inert until the layout lands would also take the
        // menu away from the keyboard and from a screen reader for a whole round trip on a first visit
        // — a menu in registry order beats no menu at all, and the gate exists to avoid showing a
        // re-sort, not to withhold navigation. `tests/app/navPrefetch.test.tsx` pins that first paint.
        className={`absolute inset-x-0 bottom-24 top-0 ${layoutReady ? 'opacity-100' : 'opacity-0'} before:absolute before:bottom-0 before:left-[var(--rail-axis)] before:top-5 before:w-px before:bg-gradient-to-b before:from-transparent before:via-accent/45 before:to-accent/10`}
        style={{ ['--rail-axis' as string]: axis }}
      >
        {routeEntries.map((entry, index) => {
          const entryKey = entry.id ?? entry.label;
          const distance = Math.abs(index - activeIndex);
          const active = entryIsActive(entry, pathname);
          const Icon = entry.icon;
          const dragged = drag?.worldId !== undefined && entry.worldId === drag.worldId;
          const scale = active ? 1 : Math.max(0.78, 0.94 - distance * 0.025);
          const opacity = active ? 1 : Math.max(0.52, 0.9 - distance * 0.045);
          return (
            <div
              key={entryKey}
              role="listitem"
              data-dragging={dragged || undefined}
              onContextMenu={entry.worldId
                ? (event) => customization.onEntryContextMenu(event, { ...entry, id: entry.worldId })
                : customization.onSurfaceContextMenu}
              onPointerDown={(event) => onEntryPointerDown(event, entry)}
              onPointerMove={onEntryPointerMove}
              onPointerUp={onEntryPointerUp}
              onPointerCancel={onEntryPointerUp}
              onLostPointerCapture={onEntryLostPointerCapture}
              onClickCapture={(event) => {
                if (!suppressClick.current) return;
                suppressClick.current = false;
                event.preventDefault();
                event.stopPropagation();
              }}
              className={`absolute left-0 top-1/2 ${dragged ? 'z-20 cursor-grabbing' : 'z-10'} ${entry.worldId && !drag ? 'cursor-grab' : ''} ${animate && !dragged ? 'transition-[transform,opacity,filter] duration-[620ms] ease-[cubic-bezier(.16,1,.3,1)]' : ''}`}
              style={{
                transform: `translate(0, calc(-50% + ${positions[index] + shiftOf(entry) + axisOffset}px)) scale(${dragged ? scale * 1.06 : scale})`,
                opacity,
                filter: `blur(${Math.max(0, distance - 6) * 0.08}px)`,
                transformOrigin: `${axis} center`,
                touchAction: entry.worldId ? 'none' : undefined,
              }}
            >
              <Link
                href={entry.href ?? '#'}
                draggable={false}
                aria-label={compact ? entry.label : undefined}
                aria-current={active ? 'page' : undefined}
                className={`group flex items-center gap-2 whitespace-nowrap ${active ? 'text-accent' : 'text-text-muted hover:text-text'}`}
                title={compact ? undefined : entry.label}
              >
                <span className={`flex shrink-0 justify-center ${compact ? 'w-[4.4rem]' : 'w-[5rem]'}`} aria-hidden>
                  <span className={`orbit-node grid shrink-0 place-items-center rounded-full border bg-black transition-[width,height,border-color,box-shadow] duration-[520ms] ease-[cubic-bezier(.16,1,.3,1)] ${active
                    ? `orbit-node-active border-accent ${compact ? 'h-[4.35rem] w-[4.35rem]' : 'h-[4.65rem] w-[4.65rem]'}`
                    : `border-border-strong/80 ${compact ? 'h-[2.45rem] w-[2.45rem]' : 'h-[2.65rem] w-[2.65rem]'}`}`}>
                    <Icon size={active ? 24 : 17} strokeWidth={1.45} />
                  </span>
                </span>
                {/* The active entry renders ~40% larger, so a label that fits at rest can outgrow the
                    rail once it is selected. `min-w-0` + `truncate` end that in an ellipsis instead of a
                    word cut off mid-glyph against the rail's `overflow-hidden`; the `title` above keeps
                    the full text reachable. Plugin labels are translated by their own authors, so no
                    length is guaranteed. */}
                {!compact ? <span className={`min-w-0 truncate ${active ? 'text-[1.65rem] font-medium' : 'text-[1.16rem]'} tracking-[-0.03em]`}>{entry.label}</span> : null}
              </Link>
            </div>
          );
        })}
      </div>
      {!compact ? (
        <div className="absolute inset-x-0 bottom-0 z-20 flex flex-col items-center bg-gradient-to-t from-black via-black to-transparent pb-5 pt-8">
          <div className="spatial-scroll-cue mb-3 flex flex-col items-center font-mono text-[8px] font-semibold tracking-[.24em] text-text-muted/45" aria-hidden>
            <span>SCROLL</span>
            <span className="mt-1 h-3 w-px bg-gradient-to-b from-accent/45 to-transparent" />
            <ChevronDown size={11} className="-mt-0.5 text-accent/55" />
          </div>
          <div className="flex justify-center font-mono text-[9px] tracking-[.14em] text-text-muted/35"><span>&lt;</span><span className="mx-3">{health.data?.version ? `v${health.data.version}` : '—'}</span><span>&gt;</span></div>
        </div>
      ) : null}
      {/* The keyboard's way into the menu that the right-click and the long press open. It has to exist
          independently of the entries: hide them all and there is nothing left to open a menu ON. */}
      <button
        type="button"
        aria-label={t.nav.showHidden}
        title={t.nav.showHidden}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          customization.openSurfaceMenu(box.left + box.width / 2, box.top);
        }}
        className="absolute bottom-1 left-1/2 z-30 -translate-x-1/2 rounded-full p-1.5 text-text-muted/40 transition-colors hover:text-text focus-visible:text-text"
      >
        <MoreHorizontal size={13} />
      </button>
      {onToggleCollapse ? (
        <CollapseHandle side={side} label={compact ? t.common.expandNav : t.common.collapseNav} onToggle={onToggleCollapse} />
      ) : null}
    </nav>
    {customization.overlays}
    </>
  );
}
