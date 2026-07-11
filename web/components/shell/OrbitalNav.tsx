'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useHealth } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { usePageHeader } from '../../lib/pageHeader';
import { navigationWorldForPath } from '../../modules/registry';
import { entryIsActive } from './NavGroup';
import { useShellNavigation } from './useShellNavigation';
import type { NavEntry } from './NavItem';

/** A narrow spatial axis. Destinations recede above and below the focused node instead of forming
 *  a conventional scrolling sidebar; wheel/keyboard move the focus without forcing navigation. */
export function OrbitalNav({ compact = false, side = 'left' }: { compact?: boolean; side?: 'left' | 'right' }) {
  const pathname = usePathname();
  const { worlds, systemItems } = useShellNavigation();
  const health = useHealth();
  const { t } = useTranslation();
  const pageHeader = usePageHeader();
  const { title, count } = pageHeader?.header ?? {};
  const world = navigationWorldForPath(pathname);
  const context = world
    ? t.nav[world.id]
    : pathname.startsWith('/account') || pathname.startsWith('/settings') || pathname.startsWith('/users')
      ? t.nav.system
      : pathname.startsWith('/escalations')
        ? t.sidebar.notifications
        : undefined;
  const entries = useMemo<NavEntry[]>(() => [
    ...worlds.flatMap((world) => world.id === 'work' || world.id === 'projects'
      ? (world.subItems ?? []).map((item) => ({ ...item, icon: item.icon ?? world.icon }))
      : [world]),
    ...systemItems.flatMap((group) => group.subItems?.length
      ? group.subItems.map((item) => ({ ...item, icon: item.icon ?? group.icon }))
      : [group]),
  ], [worlds, systemItems]);
  const routeIndex = Math.max(0, entries.findIndex((entry) => entryIsActive(entry, pathname)));
  const [focusIndex, setFocusIndex] = useState(routeIndex);
  const wheelLock = useRef(0);
  useEffect(() => setFocusIndex(routeIndex), [routeIndex]);

  const move = (step: number) => setFocusIndex((current) => Math.max(0, Math.min(entries.length - 1, current + step)));

  return (
    <nav
      data-side={side}
      data-testid="future-navigation"
      aria-label={t.common.primaryNav}
      className={`relative h-full shrink-0 overflow-hidden bg-black ${compact ? 'w-20' : 'w-[13rem]'}`}
      onWheel={(event) => {
        const now = performance.now();
        if (Math.abs(event.deltaY) < 8 || now - wheelLock.current < 150) return;
        event.preventDefault();
        wheelLock.current = now;
        move(event.deltaY > 0 ? 1 : -1);
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
        if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
      }}
    >
      {!compact ? (
        <div className="pointer-events-none absolute left-8 right-0 top-4 z-30 min-w-0 bg-gradient-to-b from-black via-black/95 to-transparent pb-8 pr-3 pt-1">
          {context ? <div className="font-mono text-[9px] font-semibold uppercase tracking-[.16em] text-accent/70">{context}</div> : null}
          <div className="mt-1 flex min-w-0 items-baseline gap-2">
            {title ? <h1 className="truncate whitespace-nowrap font-display text-base font-semibold tracking-[-0.025em] text-text">{title}</h1> : null}
            {count !== undefined ? <span className="shrink-0 font-mono text-[9px] text-text-muted">{count}</span> : null}
          </div>
        </div>
      ) : null}
      <div role="list" className="absolute inset-x-0 bottom-14 top-0">
        {entries.map((entry, index) => {
          const delta = index - focusIndex;
          const distance = Math.abs(delta);
          const focused = delta === 0;
          const active = entryIsActive(entry, pathname);
          const Icon = entry.icon;
          const scale = focused ? 1 : Math.max(0.72, 0.96 - distance * 0.055);
          const opacity = focused ? 1 : Math.max(0.38, 0.88 - distance * 0.09);
          const y = delta * (compact ? 50 : 55);
          const x = delta < 0 ? -Math.min(10, distance * 2) : Math.min(4, distance);
          return (
            <div
              key={entry.id ?? entry.label}
              role="listitem"
              className={`absolute top-[47%] z-10 transition-[transform,opacity,filter] duration-300 ease-out ${compact ? 'left-4' : 'left-[2rem]'}`}
              style={{
                transform: `translate(${x}px, calc(-50% + ${y}px)) scale(${scale})`,
                opacity,
                filter: `blur(${Math.max(0, distance - 4) * 0.12}px)`,
                transformOrigin: 'left center',
                pointerEvents: distance > 6 ? 'none' : 'auto',
              }}
            >
              <Link
                href={entry.href ?? '#'}
                aria-label={compact ? entry.label : undefined}
                aria-current={active ? 'page' : undefined}
                className={`group flex items-center gap-3 whitespace-nowrap ${focused ? 'text-accent' : active ? 'text-text' : 'text-text-muted hover:text-text'}`}
              >
                <span className={`orbit-node grid shrink-0 place-items-center rounded-full border bg-black transition-[width,height,border-color,box-shadow] duration-300 ${focused ? 'orbit-node-active h-16 w-16 border-accent shadow-[0_0_40px_rgb(255_82_54_/_0.4)]' : 'h-12 w-12 border-border-strong/80'}`}>
                  <Icon size={focused ? 23 : 17} strokeWidth={1.45} aria-hidden />
                </span>
                {!compact ? <span className={`${focused ? 'text-xl font-medium' : 'text-sm'} tracking-tight`}>{entry.label}</span> : null}
              </Link>
            </div>
          );
        })}
      </div>
      {!compact ? <div className="absolute inset-x-0 bottom-0 z-20 flex justify-center bg-gradient-to-t from-black via-black to-transparent pb-5 pt-8 font-mono text-[9px] tracking-[.14em] text-text-muted/35"><span>&lt;</span><span className="mx-3">{health.data?.version ? `v${health.data.version}` : '—'}</span><span>&gt;</span></div> : null}
    </nav>
  );
}
