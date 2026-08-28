'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { useShellProfile } from '../../lib/shellProfile';
import { Segmented } from './Segmented';
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

/** The same section selector, drawn as a row of tabs.
 *
 *  It is the SHARED `Segmented` in its `line` variant rather than a second control: the two already
 *  agree on everything that matters — a radiogroup, one roving tab stop, arrow/Home/End to move, the
 *  selection owned by the caller — so this is a presentation of one control, not a fork of it. The rail
 *  above is 8.2rem of orbit nodes with glowing rings and ember flicker; on a design whose whole argument
 *  is that structure comes from arrangement, that is a second navigation shouting over the first.
 *
 *  `nowrap` on purpose: a section selector that wraps onto three lines stops being a row you scan. It
 *  scrolls horizontally instead, which is what a phone gets. */
function SectionTabs({ sections, value, onChange, ariaLabel }: WorkspaceShellNavigation) {
  return (
    <Segmented
      className="workspace-shell__tabs"
      variant="line"
      nowrap
      aria-label={ariaLabel}
      value={value}
      onChange={onChange}
      options={sections.map((section) => ({ value: section.id, label: section.label, icon: section.icon, count: section.count }))}
    />
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
  // WHICH section selector, from the shell profile and nothing else — the same seam the navigation and
  // the page bar are swapped on. A page states its sections; it never states how they are drawn.
  const sectionsAsTabs = useShellProfile() === 'command';
  return (
    <div className={`workspace-shell ${className}`.trim()} data-variant={variant}>
      <WorkspaceHero {...hero} />
      {navigation ? (sectionsAsTabs ? <SectionTabs {...navigation} /> : <SpatialSectionRail {...navigation} />) : null}
      {/* One content region for all three variants. The test id stays variant-specific because it is
          how each page's own suite names its surface, and `.spatial-content-surface` is the hook the
          settings and account module stylesheets already override the padding through. */}
      <section
        className="workspace-shell__content spatial-content-surface"
        data-testid={variant === 'register' ? 'spatial-workspace-layout' : 'spatial-content-surface'}
      >
        {children}
      </section>
    </div>
  );
}
