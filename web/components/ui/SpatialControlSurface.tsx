'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { AutoSaveStatus } from './AutoSaveStatus';
import type { SaveStatus } from '../../lib/useAutoSaveStatus';
import { SpatialMascot, type SpatialMascotState } from './SpatialMascot';

export interface SpatialSection {
  id: string;
  label: string;
  icon: LucideIcon;
  description?: string;
}

function orbitPoint(index: number, count: number): { left: string; top: string } {
  const angle = -92 + (index * 360) / Math.max(count, 1);
  const radians = (angle * Math.PI) / 180;
  return { left: `${50 + Math.cos(radians) * 42}%`, top: `${49 + Math.sin(radians) * 38}%` };
}

function mascotState(status: SaveStatus): SpatialMascotState {
  if (status === 'saving') return 'saving';
  if (status === 'saved') return 'success';
  if (status === 'error') return 'error';
  return 'idle';
}

export function SpatialControlSurface({ sections, value, onChange, ariaLabel, status = 'idle', onRetry, children }: {
  sections: SpatialSection[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
  status?: SaveStatus;
  onRetry?: () => void;
  children: ReactNode;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [desktopSpatial, setDesktopSpatial] = useState(false);
  const active = sections.find((section) => section.id === value) ?? sections[0];
  const ActiveIcon = active?.icon;

  useEffect(() => {
    const media = window.matchMedia('(min-width: 901px)');
    const update = () => setDesktopSpatial(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);

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
    <div className="spatial-control-surface">
      <aside className="spatial-control-surface__orbit" aria-label={ariaLabel}>
        <div className="spatial-orbit-stage">
          <span className="spatial-orbit-path spatial-orbit-path--one" aria-hidden />
          <span className="spatial-orbit-path spatial-orbit-path--two" aria-hidden />
          <span className="spatial-orbit-path spatial-orbit-path--three" aria-hidden />
          <div className="spatial-orbit-mascot">{desktopSpatial ? <SpatialMascot state={mascotState(status)} /> : null}</div>
          <nav role="radiogroup" aria-label={ariaLabel} className="spatial-orbit-nav">
            {sections.map((section, index) => {
              const selected = section.id === value;
              const Icon = section.icon;
              return (
                <button
                  key={section.id}
                  ref={(node) => { refs.current[section.id] = node; }}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => onChange(section.id)}
                  onKeyDown={(event) => move(event, index)}
                  className={`spatial-orbit-node ${selected ? 'spatial-orbit-node--active' : ''}`}
                  style={orbitPoint(index, sections.length)}
                >
                  <span className="spatial-orbit-node__icon"><Icon size={selected ? 20 : 16} strokeWidth={1.55} aria-hidden /></span>
                  <span>{section.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

      </aside>

      <section className="spatial-document">
        {active && ActiveIcon ? (
          <header className="spatial-document__header">
            <span className="spatial-document__icon"><ActiveIcon size={22} strokeWidth={1.5} aria-hidden /></span>
            <div className="min-w-0 flex-1">
              <h2>{active.label}</h2>
              {active.description ? <p>{active.description}</p> : null}
            </div>
            <AutoSaveStatus status={status} onRetry={onRetry} />
          </header>
        ) : null}
        <div className="spatial-document__body">{children}</div>
      </section>
    </div>
  );
}
