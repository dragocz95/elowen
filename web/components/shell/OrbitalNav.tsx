'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, type WheelEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import { useHealth } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { entryIsActive } from './NavGroup';
import { useShellNavigation } from './useShellNavigation';
import type { NavEntry } from './NavItem';

const SPATIAL_ROUTE_ORDER = ['/projects', '/editor', '/stats', '/memory', '/timeline', '/account', '/sessions', '/kanban', '/settings', '/tasks', '/users', '/dash'];

/** A straight spatial axis. The active route is always the nearest/largest node; surrounding
 *  destinations recede in place without a serpentine horizontal curve or pointer-driven reshuffle. */
export function OrbitalNav({ compact = false, side = 'left' }: { compact?: boolean; side?: 'left' | 'right' }) {
  const pathname = usePathname();
  const router = useRouter();
  const { worlds, systemItems } = useShellNavigation();
  const health = useHealth();
  const { t } = useTranslation();
  const lastWheelAt = useRef(0);
  const previousDeltas = useRef<Record<string, number>>({});
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
  const above = Math.min(5, Math.max(0, routeEntries.length - 1));
  const deltas = useMemo(() => Object.fromEntries(routeEntries.map((entry, index) => {
    const raw = index - activeIndex;
    const delta = ((raw + above + routeEntries.length) % routeEntries.length) - above;
    return [entry.id ?? entry.label, delta];
  })), [activeIndex, above, routeEntries]);
  useEffect(() => { previousDeltas.current = deltas; }, [deltas]);
  const onWheel = (event: WheelEvent<HTMLElement>) => {
    if (Math.abs(event.deltaY) < 8 || routeEntries.length === 0) return;
    event.preventDefault();
    const now = performance.now();
    if (now - lastWheelAt.current < 420) return;
    lastWheelAt.current = now;
    const current = Math.max(0, routeEntries.findIndex((entry) => entryIsActive(entry, pathname)));
    const direction = event.deltaY > 0 ? 1 : -1;
    const next = routeEntries[(current + direction + routeEntries.length) % routeEntries.length];
    if (next?.href) router.push(next.href);
  };

  return (
    <nav
      data-side={side}
      data-testid="future-navigation"
      aria-label={t.common.primaryNav}
      onWheel={onWheel}
      className={`relative h-full shrink-0 overflow-hidden border-border/45 bg-black ${side === 'right' ? 'border-l' : 'border-r'} ${compact ? 'w-[4.75rem]' : 'w-[14.5rem]'}`}
    >
      <div role="list" className="absolute inset-x-0 bottom-24 top-0 before:absolute before:bottom-0 before:left-[2.2rem] before:top-5 before:w-px before:bg-gradient-to-b before:from-transparent before:via-accent/45 before:to-accent/10">
        {routeEntries.map((entry) => {
          const entryKey = entry.id ?? entry.label;
          const delta = deltas[entryKey] ?? 0;
          const previousDelta = previousDeltas.current[entryKey];
          // The one destination wrapping from the far end of the rail to the other should quietly
          // reappear there; animating it through every intermediate route would cross the whole axis.
          const wrapsRail = previousDelta !== undefined && Math.abs(previousDelta - delta) > routeEntries.length / 2;
          const distance = Math.abs(delta);
          const active = entryIsActive(entry, pathname);
          const Icon = entry.icon;
          const scale = active ? 1 : Math.max(0.78, 0.94 - distance * 0.025);
          const opacity = active ? 1 : Math.max(0.52, 0.9 - distance * 0.045);
          const y = delta * (compact ? 52 : 58);
          return (
            <div
              key={entryKey}
              role="listitem"
              className="absolute left-0 top-[49%] z-10 transition-[transform,opacity,filter] duration-[620ms] ease-[cubic-bezier(.16,1,.3,1)]"
              style={{
                transform: `translate(0, calc(-50% + ${y}px)) scale(${scale})`,
                opacity,
                filter: `blur(${Math.max(0, distance - 6) * 0.08}px)`,
                transformOrigin: '2.2rem center',
                transitionDuration: wrapsRail ? '0ms' : undefined,
              }}
            >
              <Link
                href={entry.href ?? '#'}
                aria-label={compact ? entry.label : undefined}
                aria-current={active ? 'page' : undefined}
                className={`group flex items-center gap-2 whitespace-nowrap ${active ? 'text-accent' : 'text-text-muted hover:text-text'}`}
              >
                <span className="flex w-[4.4rem] shrink-0 justify-center" aria-hidden>
                  <span className={`orbit-node grid shrink-0 place-items-center rounded-full border bg-black transition-[width,height,border-color,box-shadow] duration-[520ms] ease-[cubic-bezier(.16,1,.3,1)] ${active ? 'orbit-node-active h-[4.35rem] w-[4.35rem] border-accent shadow-[var(--glow-active)]' : 'h-[2.45rem] w-[2.45rem] border-border-strong/80'}`}>
                    <Icon size={active ? 24 : 17} strokeWidth={1.45} />
                  </span>
                </span>
                {!compact ? <span className={`${active ? 'text-[1.5rem] font-medium' : 'text-[1.08rem]'} tracking-[-0.03em]`}>{entry.label}</span> : null}
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
    </nav>
  );
}
