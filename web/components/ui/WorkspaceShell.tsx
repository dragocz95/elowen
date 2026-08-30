'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { useMobileViewport } from '../../lib/useMobile';
import { consumeHorizontalWheel, revealHorizontalItem } from './horizontalScroll';
import { Segmented } from './Segmented';
import { PageToolbar, PageToolbarPortal, PageToolbarProvider, PageToolbarScope, type PageToolbarProps } from './PageToolbar';
import { WorkspaceHero, type WorkspaceHeroProps } from './WorkspaceHero';

/** The page toolbar's portal under its pre-move names. The slot itself left the hero for the canonical
 *  toolbar row below the section navigation; `ControlSurfaceToolbar`, `SettingsToolbar`, `/settings` and
 *  `/account` reach it by THESE names, and a rename they can all see is not what this change is about. */
export { PageToolbarPortal as WorkspaceLeadPortal, PageToolbarScope as WorkspaceLeadScope };

export interface SpatialDeckSection {
  id: string;
  label: string;
  icon: LucideIcon;
  description?: string;
  count?: number;
}

/** The legacy horizontal section selector retained for bundles that mount it directly. */
export function SpatialSectionRail({ sections, value, onChange, ariaLabel }: {
  sections: SpatialDeckSection[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    const track = rail.current;
    const active = refs.current[value];
    if (track && active) revealHorizontalItem(track, active);
  }, [value]);

  useEffect(() => {
    const track = rail.current;
    if (!track) return;
    const onWheel = (event: WheelEvent) => { consumeHorizontalWheel(track, event); };
    track.addEventListener('wheel', onWheel, { passive: false });
    return () => track.removeEventListener('wheel', onWheel);
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
    <div
      ref={rail}
      data-testid="spatial-section-rail"
      className="spatial-section-rail"
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

type WorkspaceSectionLayout = 'sidebar' | 'tabs';

/** Registers keep horizontal tabs at every width. Configuration decks use a vertical sidebar from the
 *  tablet breakpoint upward and the same single-line, touch-scrollable tabs only on phones. */
function SectionNavigation({ sections, value, onChange, ariaLabel, layout }: WorkspaceShellNavigation & { layout: WorkspaceSectionLayout }) {
  const tabs = layout === 'tabs';
  return (
    <nav className="workspace-shell__section-navigation min-w-0" data-layout={layout} aria-label={ariaLabel}>
      <Segmented
        aria-label={ariaLabel}
        value={value}
        onChange={onChange}
        variant={tabs ? 'line' : 'menu'}
        nowrap={tabs}
        options={sections.map((section) => ({
          value: section.id,
          label: section.label,
          icon: tabs ? undefined : section.icon,
          count: section.count,
        }))}
      />
    </nav>
  );
}

/** Which information structure the page carries — NOT a visual theme.
 *
 *  register — a browsable collection with live figures, metrics and optional section tabs.
 *  deck     — a configuration surface with a desktop/tablet section sidebar and phone tabs.
 *  single   — one working surface under a title block, with no section navigation. */
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
  /** The page's own toolbar contents. Omit it and the row is still mounted — it carries the portal slot
   *  that panels deeper in the tree claim through `WorkspaceLeadPortal`. */
  toolbar?: PageToolbarProps;
  children: ReactNode;
  className?: string;
}

/** The canonical page shell. Public props and the pre-unification aliases stay stable so core pages and
 *  plugin bundles inherit responsive section navigation without owning a second breakpoint decision. */
export function WorkspaceShell({ variant = 'register', hero, navigation, toolbar, children, className = '' }: WorkspaceShellProps) {
  const phone = useMobileViewport();
  const sectionLayout: WorkspaceSectionLayout | undefined = navigation
    ? variant === 'deck'
      ? phone === undefined ? undefined : phone ? 'tabs' : 'sidebar'
      : 'tabs'
    : undefined;

  const content = (
    <section
      className="workspace-shell__content spatial-content-surface"
      data-testid={variant === 'register' ? 'spatial-workspace-layout' : 'spatial-content-surface'}
    >
      {children}
    </section>
  );

  return (
    <PageToolbarProvider>
      <div
        className={`workspace-shell ${className}`.trim()}
        data-variant={variant}
        data-section-layout={sectionLayout}
      >
        <WorkspaceHero {...hero} />
        {navigation && sectionLayout ? <SectionNavigation {...navigation} layout={sectionLayout} /> : null}
        <PageToolbar {...toolbar} />
        {content}
      </div>
    </PageToolbarProvider>
  );
}
