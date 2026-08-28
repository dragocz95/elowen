'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { useShellProfile } from '../../lib/shellProfile';
import { Segmented } from './Segmented';
import { SelectMenu } from './SelectMenu';
import { WorkspaceHero, type WorkspaceHeroProps } from './WorkspaceHero';

export interface SpatialDeckSection {
  id: string;
  label: string;
  icon: LucideIcon;
  description?: string;
  count?: number;
}

/** The horizontal section selector every shell shares. It is a radiogroup rather than a tablist: the
 *  sections switch a whole page's working surface, not a panel inside one, and the router keeps the
 *  selection. */
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

/** One section model, two responsive presentations: a Vercel-style secondary sidebar while there is
 *  room, and a compact select on narrow screens. Both write through the caller's single `onChange`; pages
 *  never decide which presentation they use and plugin decks cannot drift from host settings. */
function SectionNavigation({ sections, value, onChange, ariaLabel }: WorkspaceShellNavigation) {
  const options = sections.map((section) => ({
    value: section.id,
    label: section.label,
    icon: section.icon,
    count: section.count,
  }));
  return (
    <div className="workspace-shell__section-navigation">
      <aside className="workspace-shell__section-sidebar" aria-label={ariaLabel}>
        <Segmented
          variant="menu"
          aria-label={ariaLabel}
          value={value}
          onChange={onChange}
          options={options}
        />
      </aside>
      <div className="workspace-shell__section-mobile">
        <SelectMenu
          value={value}
          onChange={onChange}
          label={ariaLabel}
          options={sections.map((section) => {
            const Icon = section.icon;
            return {
              value: section.id,
              label: section.count === undefined ? section.label : `${section.label} (${section.count})`,
              icon: <Icon size={15} aria-hidden />,
            };
          })}
        />
      </div>
    </div>
  );
}

/** Which information structure the page carries — NOT a visual theme.
 *
 *  register — a browsable collection with live figures: mascot hero, metric row, optional section rail.
 *  deck     — a configuration surface: section rail over one settings surface at a time.
 *  single   — one working surface under a title block, no rail.
 *
 *  All three share the same anatomy (hero, optional rail, content) and therefore the same gutter, the
 *  same width cap and the same vertical rhythm. The variant only decides which parts are present. */
type WorkspaceShellVariant = 'register' | 'deck' | 'single';

interface WorkspaceShellNavigation {
  sections: SpatialDeckSection[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
}

export interface WorkspaceShellProps {
  variant?: WorkspaceShellVariant;
  hero: WorkspaceHeroProps;
  navigation?: WorkspaceShellNavigation;
  children: ReactNode;
  className?: string;
}

/** The canonical page shell. Every full-page workspace in the app is this component; the older
 *  SpatialWorkspaceLayout / SpatialControlDeck / CompactWorkspaceHeader names are thin aliases onto it
 *  so the bundles that call them by name keep working unchanged. */
export function WorkspaceShell({ variant = 'register', hero, navigation, children, className = '' }: WorkspaceShellProps) {
  // WHICH section navigation, from the shell profile and nothing else. A page states its sections; it
  // never chooses a sidebar, rail or mobile selector, so host and plugin pages stay one pattern.
  const commandSections = useShellProfile() === 'command' && navigation;
  const content = (
    <section
      className="workspace-shell__content spatial-content-surface"
      data-testid={variant === 'register' ? 'spatial-workspace-layout' : 'spatial-content-surface'}
    >
      {children}
    </section>
  );

  if (commandSections) {
    return (
      <div className={`workspace-shell ${className}`.trim()} data-variant={variant} data-section-layout="sidebar">
        <div className="workspace-shell__section-layout">
          <SectionNavigation {...navigation} />
          <div className="workspace-shell__section-main">
            <WorkspaceHero {...hero} />
            {content}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`workspace-shell ${className}`.trim()} data-variant={variant}>
      <WorkspaceHero {...hero} />
      {navigation ? <SpatialSectionRail {...navigation} /> : null}
      {content}
    </div>
  );
}
