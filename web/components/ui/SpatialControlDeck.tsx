'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { SaveStatus } from '../../lib/useAutoSaveStatus';
import { AutoSaveStatus } from './AutoSaveStatus';

export interface SpatialDeckSection {
  id: string;
  label: string;
  icon: LucideIcon;
  description?: string;
  count?: number;
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

export function SpatialControlDeck({ eyebrow, sections, value, onChange, ariaLabel, status = 'idle', onRetry, children }: {
  eyebrow: string;
  sections: SpatialDeckSection[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
  status?: SaveStatus;
  onRetry?: () => void;
  children: ReactNode;
}) {
  const active = sections.find((section) => section.id === value) ?? sections[0];
  if (!active) return null;

  return (
    <div className="spatial-control-deck">
      <header className="spatial-deck-heading">
        <div className="min-w-0">
          <span className="spatial-deck-heading__eyebrow">{eyebrow}</span>
          <h1>{active.label}</h1>
          {active.description ? <p>{active.description}</p> : null}
        </div>
        <AutoSaveStatus status={status} onRetry={onRetry} />
      </header>
      <SpatialSectionRail sections={sections} value={active.id} onChange={onChange} ariaLabel={ariaLabel} />
      <SpatialContentSurface>{children}</SpatialContentSurface>
    </div>
  );
}
