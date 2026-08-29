'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { useElementWidth } from '../../lib/useElementWidth';
import { Segmented } from './Segmented';
import { SelectMenu } from './SelectMenu';
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

/** How the section navigation presents itself. ONE section model, three shapes, and the shell decides
 *  which one from the variant and the room it actually has — a page never picks a shape itself.
 *
 *  tabs    — the quiet underline track IN THE PAGE, directly under the metric rail. A browsable register
 *            has few sections and they read as a filter over one collection, which is what a tab row is.
 *  sidebar — a vertical column beside the surface it configures. A configuration deck carries a long,
 *            growing, unordered set of sections whose names are the only way to tell them apart, and a
 *            horizontal track answers that by scrolling half of them off the page.
 *  select  — one compact picker. The same deck with no room for a column of its own; a vertical menu
 *            there would spend the whole first screen on navigation before the surface begins.
 *
 *  This is INTERNAL. No prop, no call site and no plugin bundle names a layout, so the deck surfaces
 *  (`/settings`, `/account`, every plugin config surface through `SpatialControlDeck`) change shape
 *  without a single one of them being touched. */
type SectionLayout = 'tabs' | 'sidebar' | 'select';

/** The room a deck needs before it gets a section column of its own, in CSS pixels of the shell's own
 *  content box. Below it the column and the surface beside it would both be too narrow to read, so the
 *  deck folds to the picker instead.
 *
 *  It is measured on the SHELL rather than matched against the window: the same page renders beside a
 *  pinned advisor dock and inside a plugin host, and only the space the page actually has can answer
 *  this. `useElementWidth` reports 0 until the first observation, which is deliberately read as the wide
 *  answer — a deck must not paint the phone picker for a frame on a desktop. The stylesheet carries the
 *  complementary phone guard, so the wide first paint cannot lay out a two-column grid on a 390px screen
 *  either. */
const SECTION_SIDEBAR_MIN_WIDTH = 900;

function resolveSectionLayout(variant: WorkspaceShellVariant, shellWidth: number): SectionLayout {
  if (variant !== 'deck') return 'tabs';
  return shellWidth === 0 || shellWidth >= SECTION_SIDEBAR_MIN_WIDTH ? 'sidebar' : 'select';
}

/** The section navigation, IN THE PAGE.
 *
 * It used to portal itself into the shell's top bar, which put a page's sections in the window chrome
 * beside the global controls — the sections belong to the page, they change with it, and the top bar is
 * the one strip that does not. The chat surface still portals its own conversation controls up there
 * (`PageTopBarPortal`, modules/advisor/BrainChatSurface.tsx); that is a different decision about a
 * different set of controls and is untouched.
 *
 * Every shape keeps the same accessible name and the same single-choice semantics. `tabs` and `sidebar`
 * are the shared `Segmented` under its two existing variants — a radiogroup with a roving tab stop —
 * and `select` is the shared `SelectMenu`, a combobox. The picker has no place to put a count beside a
 * label, so the count is folded INTO the label rather than dropped: a section that carries a figure on a
 * desktop must still carry it on a phone. */
function SectionNavigation({ sections, value, onChange, ariaLabel, layout }: WorkspaceShellNavigation & { layout: SectionLayout }) {
  return (
    <nav className="workspace-shell__section-navigation min-w-0" data-layout={layout} aria-label={ariaLabel}>
      {layout === 'select' ? (
        <SelectMenu
          value={value}
          onChange={onChange}
          label={ariaLabel}
          variant="line"
          options={sections.map((section) => {
            const Icon = section.icon;
            return {
              value: section.id,
              label: section.count === undefined ? section.label : `${section.label} (${section.count})`,
              icon: <Icon size={16} strokeWidth={1.6} aria-hidden />,
            };
          })}
        />
      ) : (
        <Segmented
          aria-label={ariaLabel}
          value={value}
          onChange={onChange}
          variant={layout === 'sidebar' ? 'menu' : 'line'}
          // A horizontal track has to stay on one line and scroll; a vertical column has no such axis.
          nowrap={layout === 'tabs'}
          options={sections.map((section) => ({
            value: section.id,
            label: section.label,
            count: section.count,
            // Icons belong to the column, where each row has a whole line to itself. In a tab row they
            // would double the width of every label for no gain.
            icon: layout === 'sidebar' ? section.icon : undefined,
          }))}
        />
      )}
    </nav>
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
  /** The page's own toolbar contents. Omit it and the row is still mounted — it carries the portal slot
   *  that panels deeper in the tree claim through `WorkspaceLeadPortal`. */
  toolbar?: PageToolbarProps;
  children: ReactNode;
  className?: string;
}

/** The canonical page shell. Every full-page workspace in the app is this component; the older
 *  SpatialWorkspaceLayout / SpatialControlDeck / CompactWorkspaceHeader names are thin aliases onto it
 *  so the bundles that call them by name keep working unchanged.
 *
 *  ONE anatomy, top to bottom, on every page and under every design:
 *
 *    heading + description + actions   the hero's head — what this page is
 *    metric rail                       a hairline strip of live figures, directly below it
 *    section navigation                a Segmented track, in the page and not in the window chrome
 *    toolbar row                       search, filters, page actions, and the one portal slot
 *    active filter chips               a line of their own, so the row above does not reflow
 *    content
 *
 *  It no longer branches on the shell profile. The two profiles used to ship different page anatomies —
 *  the rail-and-mascot register versus the command layout — which meant a page could not be reasoned
 *  about without also knowing which design was on the document, and the profile-specific half was the one
 *  no shipped design selected. `SpatialSectionRail` stays exported and fully functional for the bundles
 *  and forks that mount it themselves; the shell simply does not choose it for them. */
export function WorkspaceShell({ variant = 'register', hero, navigation, toolbar, children, className = '' }: WorkspaceShellProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const shellWidth = useElementWidth(shellRef);
  const layout = resolveSectionLayout(variant, shellWidth);

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
      {/* DOM ORDER IS THE ANATOMY and does not change with the layout: hero, navigation, toolbar,
          content, in that order, whichever shape the navigation takes. The sidebar arrangement is a
          grid placement in workspace-shell.css, not a different tree — a reader with no stylesheet, and
          a screen reader following the document, meet the page in the order it is written. */}
      <div
        ref={shellRef}
        className={`workspace-shell ${className}`.trim()}
        data-variant={variant}
        data-section-layout={navigation ? layout : undefined}
      >
        <WorkspaceHero {...hero} />
        {navigation ? <SectionNavigation {...navigation} layout={layout} /> : null}
        <PageToolbar {...toolbar} />
        {content}
      </div>
    </PageToolbarProvider>
  );
}
