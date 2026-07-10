'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useHealth } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { entryIsActive } from './NavGroup';
import { useShellNavigation } from './useShellNavigation';
import { NavOrbitScene } from './NavOrbitScene';

function wrapsDelta(index: number, focus: number, count: number): number {
  let delta = index - focus;
  if (delta > count / 2) delta -= count;
  if (delta < -count / 2) delta += count;
  return delta;
}

/** Desktop future navigation: an accessible DOM orbit over a WebGL ambient scene. */
export function OrbitalNav({ compact = false, side = 'left' }: { compact?: boolean; side?: 'left' | 'right' }) {
  const pathname = usePathname();
  const { worlds, systemItems } = useShellNavigation();
  const health = useHealth();
  const { t } = useTranslation();
  const entries = useMemo(() => [...worlds, ...systemItems], [worlds, systemItems]);
  const routeIndex = Math.max(0, entries.findIndex((entry) => entryIsActive(entry, pathname)));
  const [focusIndex, setFocusIndex] = useState(routeIndex);
  const wheelAt = useRef(0);

  useEffect(() => setFocusIndex(routeIndex), [routeIndex]);
  const focus = entries[focusIndex] ?? entries[0];
  const move = (step: number) => setFocusIndex((current) => (current + step + entries.length) % entries.length);
  const onWheel = (event: React.WheelEvent) => {
    const now = performance.now();
    if (now - wheelAt.current < 180 || Math.abs(event.deltaY) < 4) return;
    event.preventDefault();
    wheelAt.current = now;
    move(event.deltaY > 0 ? 1 : -1);
  };

  const centerX = compact ? 52 : 58;
  const radiusX = compact ? 27 : 86;
  const radiusY = compact ? 132 : 154;
  const mirrored = side === 'right';

  return (
    <nav
      data-testid="future-navigation"
      aria-label={t.common.primaryNav}
      onWheel={onWheel}
      onKeyDown={(event) => {
        if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
        if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
      }}
      className={`relative h-full shrink-0 overflow-visible ${compact ? 'w-28' : 'w-[22rem]'}`}
    >
      <NavOrbitScene side={side} compact={compact} />

      <div role="list" className="absolute inset-0 z-30">
        {entries.map((entry, index) => {
          const delta = wrapsDelta(index, focusIndex, entries.length);
          const angle = delta * 0.67;
          const x = centerX + Math.cos(angle) * radiusX;
          const y = Math.sin(angle) * radiusY;
          const focused = index === focusIndex;
          const active = entryIsActive(entry, pathname);
          const Icon = entry.icon;
          const position = mirrored ? { right: x } : { left: x };
          const control = `group flex items-center gap-2 whitespace-nowrap text-left transition-[color,opacity,transform,filter] duration-300 ${focused ? 'text-accent' : active ? 'text-text' : 'text-text-muted/55 hover:text-text'} ${compact ? 'justify-center' : ''}`;
          const content = (
            <>
              <span className={`grid shrink-0 place-items-center rounded-full border backdrop-blur-md transition-[width,height,border-color,background-color,box-shadow] ${focused ? 'h-11 w-11 border-accent/45 bg-accent/12 shadow-[0_0_30px_rgb(255_82_54_/_0.18)]' : 'h-9 w-9 border-border/80 bg-black/55'}`}>
                <Icon size={focused ? 18 : 16} strokeWidth={1.55} aria-hidden />
              </span>
              {!compact ? <span className={`text-sm font-medium tracking-tight ${focused ? 'translate-x-0 opacity-100' : 'opacity-70'}`}>{entry.label}</span> : null}
            </>
          );
          return (
            <div
              key={entry.id ?? entry.label}
              role="listitem"
              className="absolute top-1/2 transition-[transform,opacity] duration-500 ease-[var(--ease-out)]"
              style={{ ...position, transform: `translate(${mirrored ? '50%' : '-50%'}, calc(-50% + ${y}px)) scale(${focused ? 1 : Math.max(0.76, 0.94 - Math.abs(delta) * 0.07)})`, opacity: focused ? 1 : Math.max(0.38, 0.8 - Math.abs(delta) * 0.14), zIndex: 20 - Math.abs(delta) }}
            >
              {entry.href ? (
                <Link href={entry.href} aria-current={active ? (entry.subItems?.length ? 'location' : 'page') : undefined} className={control}>
                  {content}
                </Link>
              ) : (
                <button type="button" aria-expanded={focused && !!entry.subItems?.length} className={control} onClick={() => setFocusIndex(index)}>
                  {content}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {!compact && focus?.subItems?.length ? (
        <div className={`absolute top-1/2 z-40 flex w-36 -translate-y-1/2 flex-col gap-1 border-border/80 py-2 ${mirrored ? 'right-[11.5rem] items-end border-r pr-3 text-right' : 'left-[11.5rem] border-l pl-3'}`} aria-label={focus.label}>
          <span className="mb-1 font-mono text-[9px] uppercase tracking-[.16em] text-accent/70">{focus.label}</span>
          {focus.subItems.map((item) => {
            const current = pathname === item.href || pathname.startsWith(`${item.href}/`);
            const Icon = item.icon;
            return (
              <Link key={item.id} href={item.href} aria-current={current ? 'page' : undefined} className={`flex w-full items-center gap-2 py-1.5 text-xs transition-colors ${mirrored ? 'flex-row-reverse' : ''} ${current ? 'text-text' : 'text-text-muted hover:text-text'}`}>
                {Icon ? <Icon size={13} strokeWidth={1.5} className={current ? 'text-accent' : ''} aria-hidden /> : null}
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </div>
      ) : null}

      {!compact ? (
        <div className={`absolute bottom-5 z-30 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[.14em] text-text-muted/35 ${mirrored ? 'right-6' : 'left-6'}`}>
          <button type="button" onClick={() => move(-1)} aria-label={t.calendar.previous}><ChevronLeft size={13} aria-hidden /></button>
          <span>Elowen {health.data?.version ?? '—'}</span>
          <button type="button" onClick={() => move(1)} aria-label={t.calendar.next}><ChevronRight size={13} aria-hidden /></button>
        </div>
      ) : null}
    </nav>
  );
}
