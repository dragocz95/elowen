'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { SaveStatus } from '../../lib/useAutoSaveStatus';
import { AutoSaveStatus } from './AutoSaveStatus';
import { SpatialMascot, type SpatialMascotState } from './SpatialMascot';

export interface SpatialDeckSection {
  id: string;
  label: string;
  icon: LucideIcon;
  description?: string;
  count?: number;
}

function mascotState(status: SaveStatus): SpatialMascotState {
  if (status === 'saving') return 'saving';
  if (status === 'saved') return 'success';
  if (status === 'error') return 'error';
  return 'idle';
}

function SpatialSectionHero({ status = 'idle', onRetry, children }: {
  status?: SaveStatus;
  onRetry?: () => void;
  children?: ReactNode;
}) {
  return (
    <section className="spatial-deck-hero">
      <div className="spatial-deck-hero__mascot" data-testid="spatial-hero-mascot">
        <SpatialMascot state={mascotState(status)} />
      </div>
      <div className="spatial-deck-hero__content">{children}</div>
      <div className="spatial-deck-hero__save"><AutoSaveStatus status={status} onRetry={onRetry} /></div>
    </section>
  );
}

export function SpatialSectionRail({ sections, value, onChange, ariaLabel }: {
  sections: SpatialDeckSection[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    const active = refs.current[value];
    active?.scrollIntoView?.({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [value]);

  const move = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % sections.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + sections.length) % sections.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = sections.length - 1;
    else return;
    event.preventDefault();
    const section = sections[next];
    if (!section) return;
    onChange(section.id);
    refs.current[section.id]?.focus();
  };

  return (
    <div
      ref={rail}
      data-testid="spatial-section-rail"
      className="spatial-section-rail"
      onWheel={(event) => {
        if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
        event.preventDefault();
        event.currentTarget.scrollBy({ left: event.deltaY, behavior: 'auto' });
      }}
    >
      <nav role="radiogroup" aria-label={ariaLabel} className="spatial-section-rail__track">
        {sections.map((section, index) => {
          const selected = section.id === value;
          const Icon = section.icon;
          return (
            <button
              key={section.id}
              ref={(node) => { refs.current[section.id] = node; }}
              type="button"
              role="radio"
              aria-label={section.count === undefined ? section.label : `${section.label} ${section.count}`}
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(section.id)}
              onKeyDown={(event) => move(event, index)}
              className={`spatial-section-node ${selected ? 'spatial-section-node--active' : ''}`}
            >
              <span className="spatial-section-node__icon"><Icon size={selected ? 20 : 17} strokeWidth={1.55} aria-hidden /></span>
              <span className="spatial-section-node__label">{section.label}{section.count !== undefined ? <span className="spatial-section-node__count">{section.count}</span> : null}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

function SpatialContentSurface({ children }: { children: ReactNode }) {
  return <section data-testid="spatial-content-surface" className="spatial-content-surface">{children}</section>;
}

export function SpatialControlDeck({ eyebrow, sections, value, onChange, ariaLabel, status = 'idle', onRetry, hero, compact = false, children }: {
  eyebrow: string;
  sections: SpatialDeckSection[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
  status?: SaveStatus;
  onRetry?: () => void;
  hero?: ReactNode;
  /** PROTOTYPE(constellation): drop the hero band so the content surface starts right under the
   *  rail; the auto-save status moves into the heading row. */
  compact?: boolean;
  children: ReactNode;
}) {
  const active = sections.find((section) => section.id === value) ?? sections[0];
  if (!active) return null;

  return (
    <div className="spatial-control-deck">
      <header className={`spatial-deck-heading ${compact ? 'spatial-deck-heading--compact' : ''}`}>
        <div className="min-w-0">
          <span className="spatial-deck-heading__eyebrow">{eyebrow}</span>
          <h1>{active.label}</h1>
          {active.description ? <p>{active.description}</p> : null}
        </div>
        {compact ? <AutoSaveStatus status={status} onRetry={onRetry} /> : null}
      </header>
      {compact ? null : <SpatialSectionHero status={status} onRetry={onRetry}>{hero}</SpatialSectionHero>}
      <SpatialSectionRail sections={sections} value={active.id} onChange={onChange} ariaLabel={ariaLabel} />
      <SpatialContentSurface>{children}</SpatialContentSurface>
    </div>
  );
}
