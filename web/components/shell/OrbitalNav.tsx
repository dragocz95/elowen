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
  const wheelAt = useRef(Number.NEGATIVE_INFINITY);
  const wheelDelta = useRef(0);
  const wheelReset = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setFocusIndex(routeIndex), [routeIndex]);
  useEffect(() => () => {
    if (wheelReset.current) clearTimeout(wheelReset.current);
  }, []);
  const focus = entries[focusIndex] ?? entries[0];
  const move = (step: number) => setFocusIndex((current) => (current + step + entries.length) % entries.length);
  const onWheel = (event: React.WheelEvent) => {
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

  const centerX = compact ? 64 : 72;
  const radiusX = compact ? 34 : 108;
  const radiusY = compact ? 148 : 178;
  const mirrored = side === 'right';

  return (
    <nav
      data-testid="future-navigation"
      aria-label={t.common.primaryNav}
      onWheel={onWheel}
      onKeyDown={(event) => {
        if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
        if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
        if (event.key === 'ArrowLeft') { event.preventDefault(); move(mirrored ? 1 : -1); }
        if (event.key === 'ArrowRight') { event.preventDefault(); move(mirrored ? -1 : 1); }
      }}
      className={`relative h-full shrink-0 overflow-visible ${compact ? 'w-32' : 'w-[24rem]'}`}
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
          const control = `group flex items-center gap-2.5 whitespace-nowrap text-left transition-[color,opacity,transform,filter] duration-300 ${focused ? 'text-accent' : active ? 'text-text' : 'text-text-muted/85 hover:text-text'} ${compact ? 'justify-center' : ''}`;
          const content = (
            <>
              <span className={`orbit-node ${focused ? 'orbit-node-active' : ''} grid shrink-0 place-items-center rounded-full border backdrop-blur-md transition-[width,height,border-color,background-color,box-shadow] ${focused ? 'h-12 w-12 border-accent/50 bg-accent/12 shadow-[0_0_34px_rgb(255_82_54_/_0.2)]' : 'h-10 w-10 border-border-strong/90 bg-black/65'}`}>
                <Icon size={focused ? 20 : 18} strokeWidth={1.55} aria-hidden />
              </span>
              {!compact ? <span className={`text-base font-medium tracking-tight ${focused ? 'translate-x-0 opacity-100' : 'opacity-90'}`}>{entry.label}</span> : null}
            </>
          );
          return (
            <div
              key={entry.id ?? entry.label}
              role="listitem"
              className="absolute top-1/2 transition-[transform,opacity] duration-500 ease-[var(--ease-out)]"
              style={{ ...position, transform: `translate(${mirrored ? '50%' : '-50%'}, calc(-50% + ${y}px)) scale(${focused ? 1 : Math.max(0.8, 0.96 - Math.abs(delta) * 0.06)})`, opacity: focused ? 1 : Math.max(0.58, 0.92 - Math.abs(delta) * 0.12), zIndex: 20 - Math.abs(delta) }}
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
        <div key={focus.id ?? focus.label} className={`absolute top-1/2 z-40 w-44 -translate-y-1/2 ${mirrored ? 'right-[14rem] text-right' : 'left-[14rem]'}`} aria-label={focus.label}>
          <span aria-hidden className={`absolute top-1/2 h-px w-12 -translate-y-1/2 ${mirrored ? '-right-12 bg-gradient-to-l' : '-left-12 bg-gradient-to-r'} from-accent/55 via-accent/25 to-border`} />
          <span aria-hidden className={`absolute top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-accent shadow-[0_0_12px_rgb(255_82_54_/_0.65)] ${mirrored ? '-right-[3px]' : '-left-[3px]'}`} />
          <div className={`orbit-branch flex flex-col gap-1 py-3 ${mirrored ? 'items-end border-r border-border/90 pr-4' : 'border-l border-border/90 pl-4'}`}>
            <span className="mb-1 font-mono text-[9px] uppercase tracking-[.18em] text-accent/75">{focus.label}</span>
            {focus.subItems.map((item) => {
              const current = pathname === item.href || pathname.startsWith(`${item.href}/`);
              const Icon = item.icon;
              return (
                <Link key={item.id} href={item.href} aria-current={current ? 'page' : undefined} className={`relative flex w-full items-center gap-2 py-1.5 text-sm transition-[color,transform] duration-200 ${mirrored ? 'flex-row-reverse hover:-translate-x-1' : 'hover:translate-x-1'} ${current ? 'text-text' : 'text-text-muted/85 hover:text-text'}`}>
                  {current ? <span aria-hidden className={`absolute top-1/2 h-1 w-1 -translate-y-1/2 rounded-full bg-accent ${mirrored ? '-right-[18px]' : '-left-[18px]'}`} /> : null}
                  {Icon ? <Icon size={13} strokeWidth={1.5} className={current ? 'text-accent' : ''} aria-hidden /> : null}
                  <span className="truncate">{item.label}</span>
                </Link>
              );
            })}
          </div>
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
