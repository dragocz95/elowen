'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useMemo, useRef, type WheelEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import { useHealth } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { entryIsActive } from './NavGroup';
import { useShellNavigation } from './useShellNavigation';
import { CollapseHandle } from './CollapseHandle';
import { useElementHeight } from '../../lib/useElementWidth';
import type { NavEntry } from './NavItem';

/** Top to bottom: where you land, then the work, then the context behind it, then administration.
 *  Home first and the admin surfaces last, so the axis reads in the order you actually use it. */
const SPATIAL_ROUTE_ORDER = [
  '/dash', '/chat',                               // home, then chat
  '/tasks', '/kanban', '/sessions', '/timeline',  // the work
  '/projects', '/editor', '/memory', '/stats',    // what the work runs on
  '/account', '/settings', '/users',              // administration
];
/** The public site's rail spacing — the look this rail matches. */
const SPACING = 66;
/** Vertical room the largest (active) node needs, so the end destinations never clip. */
const NODE_HEADROOM = 80;

/** Where each destination is parked on the axis: a fixed, centered order that does NOT depend on which
 *  route is active. Only scale/opacity/blur react to the active route, so the rail never re-shuffles. */
export function getStableOffsets(count: number, spacing: number): number[] {
  const center = (count - 1) / 2;
  return Array.from({ length: count }, (_, index) => (index - center) * spacing);
}

/** The public rail carries 8 destinations at SPACING; this one carries up to 12, which overflows a
 *  laptop-height axis. Keep SPACING wherever it fits and otherwise tighten just enough to seat every
 *  destination — a rail that clips its first and last entries is worse than a slightly denser one. */
export function railSpacing(count: number, stageHeight: number): number {
  if (stageHeight <= 0 || count < 2) return SPACING;
  return Math.min(SPACING, Math.max(28, (stageHeight - NODE_HEADROOM) / (count - 1)));
}

/** A straight spatial axis. The active route is always the largest node; surrounding destinations
 *  recede in place — they never slide past each other or wrap around the ends.
 *
 *  `onToggleCollapse` is what puts the collapse handle on the edge. It is absent whenever collapsing is
 *  not the user's call — a window too narrow for the full rail is already forced compact, and a handle
 *  that cannot change anything is worse than no handle at all. */
export function OrbitalNav({ compact = false, side = 'left', onToggleCollapse }: {
  compact?: boolean;
  side?: 'left' | 'right';
  onToggleCollapse?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { worlds, systemItems } = useShellNavigation();
  const health = useHealth();
  const { t } = useTranslation();
  const lastWheelAt = useRef(0);
  const routeEntries = useMemo<NavEntry[]>(() => [
    ...worlds.flatMap((world) => world.id === 'work' || world.id === 'projects'
      ? (world.subItems ?? []).map((item) => ({ ...item, icon: item.icon ?? world.icon }))
      : [world]),
    ...systemItems.flatMap((group) => group.subItems?.length
      ? group.subItems.map((item) => ({ ...item, icon: item.icon ?? group.icon }))
      : [group]),
  ].sort((a, b) => {
    const ai = SPATIAL_ROUTE_ORDER.indexOf(a.href ?? '');
    const bi = SPATIAL_ROUTE_ORDER.indexOf(b.href ?? '');
    return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi);
  }), [worlds, systemItems]);
  const activeIndex = Math.max(0, routeEntries.findIndex((entry) => entryIsActive(entry, pathname)));
  const stageRef = useRef<HTMLDivElement>(null);
  const stageHeight = useElementHeight(stageRef);
  const positions = useMemo(
    () => getStableOffsets(routeEntries.length, railSpacing(routeEntries.length, stageHeight)),
    [routeEntries.length, stageHeight],
  );

  const onWheel = (event: WheelEvent<HTMLElement>) => {
    if (Math.abs(event.deltaY) < 8 || routeEntries.length === 0) return;
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

  return (
    <nav
      data-side={side}
      data-testid="future-navigation"
      aria-label={t.common.primaryNav}
      onWheel={onWheel}
      className={`relative h-full shrink-0 overflow-hidden border-border/45 bg-black ${side === 'right' ? 'border-l' : 'border-r'} ${compact ? 'w-[4.75rem]' : 'w-[17rem]'}`}
    >
      <div
        ref={stageRef}
        role="list"
        className="absolute inset-x-0 bottom-24 top-0 before:absolute before:bottom-0 before:left-[var(--rail-axis)] before:top-5 before:w-px before:bg-gradient-to-b before:from-transparent before:via-accent/45 before:to-accent/10"
        style={{ ['--rail-axis' as string]: axis }}
      >
        {routeEntries.map((entry, index) => {
          const entryKey = entry.id ?? entry.label;
          const distance = Math.abs(index - activeIndex);
          const active = entryIsActive(entry, pathname);
          const Icon = entry.icon;
          const scale = active ? 1 : Math.max(0.78, 0.94 - distance * 0.025);
          const opacity = active ? 1 : Math.max(0.52, 0.9 - distance * 0.045);
          return (
            <div
              key={entryKey}
              role="listitem"
              className="absolute left-0 top-[49%] z-10 transition-[transform,opacity,filter] duration-[620ms] ease-[cubic-bezier(.16,1,.3,1)]"
              style={{
                transform: `translate(0, calc(-50% + ${positions[index]}px)) scale(${scale})`,
                opacity,
                filter: `blur(${Math.max(0, distance - 6) * 0.08}px)`,
                transformOrigin: `${axis} center`,
              }}
            >
              <Link
                href={entry.href ?? '#'}
                aria-label={compact ? entry.label : undefined}
                aria-current={active ? 'page' : undefined}
                className={`group flex items-center gap-2 whitespace-nowrap ${active ? 'text-accent' : 'text-text-muted hover:text-text'}`}
              >
                <span className={`flex shrink-0 justify-center ${compact ? 'w-[4.4rem]' : 'w-[5rem]'}`} aria-hidden>
                  <span className={`orbit-node grid shrink-0 place-items-center rounded-full border bg-black transition-[width,height,border-color,box-shadow] duration-[520ms] ease-[cubic-bezier(.16,1,.3,1)] ${active
                    ? `orbit-node-active border-accent ${compact ? 'h-[4.35rem] w-[4.35rem]' : 'h-[4.65rem] w-[4.65rem]'}`
                    : `border-border-strong/80 ${compact ? 'h-[2.45rem] w-[2.45rem]' : 'h-[2.65rem] w-[2.65rem]'}`}`}>
                    <Icon size={active ? 24 : 17} strokeWidth={1.45} />
                  </span>
                </span>
                {!compact ? <span className={`${active ? 'text-[1.65rem] font-medium' : 'text-[1.16rem]'} tracking-[-0.03em]`}>{entry.label}</span> : null}
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
      {onToggleCollapse ? (
        <CollapseHandle side={side} label={compact ? t.common.expandNav : t.common.collapseNav} onToggle={onToggleCollapse} />
      ) : null}
    </nav>
  );
}
