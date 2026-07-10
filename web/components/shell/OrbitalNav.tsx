'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import * as m from 'motion/react-m';
import { useHealth } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { entryIsActive } from './NavGroup';
import { useShellNavigation } from './useShellNavigation';
import type { NavEntry } from './NavItem';

function wrapsDelta(index: number, focus: number, count: number): number {
  let delta = index - focus;
  if (delta > count / 2) delta -= count;
  if (delta < -count / 2) delta += count;
  return delta;
}

/** Desktop future navigation: accessible DOM links moving through a CSS 3D scene. */
export function OrbitalNav({ compact = false, side = 'left' }: { compact?: boolean; side?: 'left' | 'right' }) {
  const pathname = usePathname();
  const { worlds, systemItems } = useShellNavigation();
  const health = useHealth();
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
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
  const navRef = useRef<HTMLElement>(null);
  const wheelAt = useRef(Number.NEGATIVE_INFINITY);
  const wheelDelta = useRef(0);
  const wheelReset = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setFocusIndex(routeIndex), [routeIndex]);
  useEffect(() => () => {
    if (wheelReset.current) clearTimeout(wheelReset.current);
  }, []);
  const move = useCallback((step: number) => {
    setFocusIndex((current) => (current + step + entries.length) % entries.length);
  }, [entries.length]);
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) < 0.5) return;
      event.preventDefault();
      wheelDelta.current += event.deltaY;
      if (wheelReset.current) clearTimeout(wheelReset.current);
      wheelReset.current = setTimeout(() => { wheelDelta.current = 0; }, 160);
      const now = performance.now();
      if (now - wheelAt.current < 220 || Math.abs(wheelDelta.current) < 32) return;
      wheelAt.current = now;
      move(wheelDelta.current > 0 ? 1 : -1);
      wheelDelta.current = 0;
    };
    nav.addEventListener('wheel', onWheel, { passive: false });
    return () => nav.removeEventListener('wheel', onWheel);
  }, [move]);

  const centerX = compact ? 55 : 105;
  const radiusX = compact ? 50 : 100;
  const radiusY = compact ? 280 : 330;
  const mirrored = side === 'right';
  const orbitTransition = reduceMotion
    ? { duration: 0 }
    : { type: 'spring' as const, stiffness: 190, damping: 27, mass: 0.82, restDelta: 0.01 };

  return (
    <nav
      ref={navRef}
      data-testid="future-navigation"
      aria-label={t.common.primaryNav}
      onKeyDown={(event) => {
        if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
        if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
        if (event.key === 'ArrowLeft') { event.preventDefault(); move(mirrored ? 1 : -1); }
        if (event.key === 'ArrowRight') { event.preventDefault(); move(mirrored ? -1 : 1); }
      }}
      className={`relative h-full shrink-0 overflow-visible ${compact ? 'w-36' : 'w-[23rem]'}`}
    >
      <div role="list" className="absolute inset-0 z-30 [perspective:900px] [transform-style:preserve-3d]">
        {entries.map((entry, index) => {
          const delta = wrapsDelta(index, focusIndex, entries.length);
          const angle = delta * ((Math.PI * 2) / entries.length);
          const cosine = Math.cos(angle);
          const depth = (cosine + 1) / 2;
          const x = centerX + cosine * radiusX;
          const y = Math.sin(angle) * radiusY;
          const focused = index === focusIndex;
          const active = entryIsActive(entry, pathname);
          const Icon = entry.icon;
          const control = `group flex items-center gap-3 whitespace-nowrap transition-[color,opacity,transform,filter] duration-300 ${focused ? 'text-accent' : active ? 'text-text' : 'text-text-muted/85 hover:text-text'} ${compact ? 'justify-center' : ''} ${mirrored ? 'flex-row-reverse text-right' : 'text-left'}`;
          const content = (
            <>
              <span className={`orbit-node ${focused ? 'orbit-node-active' : ''} grid shrink-0 place-items-center rounded-full border backdrop-blur-md transition-[width,height,border-color,background-color,box-shadow] ${focused ? 'h-14 w-14 border-accent/50 bg-accent/12 shadow-[0_0_38px_rgb(255_82_54_/_0.22)]' : 'h-11 w-11 border-border-strong/90 bg-black/65'}`}>
                <Icon size={focused ? 22 : 19} strokeWidth={1.5} aria-hidden />
              </span>
              {!compact ? <span className={`text-lg font-medium tracking-tight ${focused ? 'translate-x-0 opacity-100' : 'opacity-90'}`}>{entry.label}</span> : null}
            </>
          );
          return (
            <m.div
              key={entry.id ?? entry.label}
              role="listitem"
              initial={false}
              animate={{
                x: mirrored ? -x : x,
                y,
                z: Math.round((depth - 0.5) * 90),
                scale: 0.7 + depth * 0.3,
                opacity: 0.28 + depth * 0.72,
                filter: focused ? 'blur(0px)' : `blur(${((1 - depth) * 1.15).toFixed(2)}px)`,
              }}
              transition={orbitTransition}
              className={`absolute top-1/2 ${mirrored ? 'right-0' : 'left-0'}`}
              style={{ transformOrigin: mirrored ? 'right center' : 'left center', zIndex: Math.round(depth * 20) }}
            >
              <div className="-translate-y-1/2">
                {entry.href ? (
                  <Link href={entry.href} aria-label={compact ? entry.label : undefined} aria-current={active ? 'page' : undefined} className={control}>
                    {content}
                  </Link>
                ) : (
                  <button type="button" aria-label={compact ? entry.label : undefined} className={control} onClick={() => setFocusIndex(index)}>
                    {content}
                  </button>
                )}
              </div>
            </m.div>
          );
        })}
      </div>

      {!compact ? (
        <div className="absolute bottom-5 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 font-mono text-[9px] uppercase tracking-[.14em] text-text-muted/35">
          <button type="button" onClick={() => move(-1)} aria-label={t.calendar.previous}><ChevronLeft size={13} aria-hidden /></button>
          <span>{health.data?.version ? `v${health.data.version}` : '—'}</span>
          <button type="button" onClick={() => move(1)} aria-label={t.calendar.next}><ChevronRight size={13} aria-hidden /></button>
        </div>
      ) : null}
    </nav>
  );
}
