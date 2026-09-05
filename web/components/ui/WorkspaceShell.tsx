'use client';

import { type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Segmented } from './Segmented';
import { PageToolbar, PageToolbarPortal, PageToolbarProvider, PageToolbarScope, type PageToolbarProps } from './PageToolbar';
import { WorkspaceHero, type WorkspaceHeroProps } from './WorkspaceHero';

/** The page toolbar's portal under its pre-move names. The slot itself left the hero for the canonical
 *  toolbar row below the hero; `ControlSurfaceToolbar`, `/settings` and `/account` reach it by THESE
 *  names, and a rename they can all see is not what this change is about. */
export { PageToolbarPortal as WorkspaceLeadPortal, PageToolbarScope as WorkspaceLeadScope };

export interface SpatialDeckSection {
  id: string;
  label: string;
  icon: LucideIcon;
  description?: string;
  count?: number;
}

/** A register's own tabs: the single-line, touch-scrollable track that switches between views of the SAME
 *  collection. It stays in the page because that is what it is — a filter over what the page is showing,
 *  not a set of addresses. A configuration deck's sections are addresses, and they live in the sidebar. */
function SectionNavigation({ sections, value, onChange, ariaLabel }: WorkspaceShellNavigation) {
  return (
    <nav className="workspace-shell__section-navigation min-w-0" data-layout="tabs" aria-label={ariaLabel}>
      <Segmented
        aria-label={ariaLabel}
        value={value}
        onChange={onChange}
        variant="line"
        nowrap
        options={sections.map((section) => ({
          value: section.id,
          label: section.label,
          count: section.count,
        }))}
      />
    </nav>
  );
}

/** Which information structure the page carries — NOT a visual theme.
 *
 *  register — a browsable collection with live figures, metrics and optional view tabs.
 *  deck     — a configuration surface whose sections are addresses, listed in the sidebar's sub-menu.
 *  single   — one working surface under a title block, with no navigation of its own. */
type WorkspaceShellVariant = 'register' | 'deck' | 'single';

interface WorkspaceShellNavigation {
  sections: SpatialDeckSection[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
}

export interface WorkspaceShellProps {
  variant?: WorkspaceShellVariant;
  /** Full pages supply the canonical hero. Embedded configuration decks can omit it when their parent
   *  surface already owns the identity block above them. */
  hero?: WorkspaceHeroProps;
  /** A register's view tabs. A deck passes nothing: its sections are addressed in the sidebar. */
  navigation?: WorkspaceShellNavigation;
  /** The page's own toolbar contents. Omit it and the row is still mounted — it carries the portal slot
   *  that panels deeper in the tree claim through `WorkspaceLeadPortal`. */
  toolbar?: PageToolbarProps;
  /** Remove full-page width, gutter and bottom-padding ownership when the shell is nested in a parent
   *  document. Navigation, toolbar and responsive breakpoint behavior remain identical. */
  embedded?: boolean;
  children: ReactNode;
  className?: string;
}

/** The canonical page shell. Public props and the pre-unification aliases stay stable so core pages and
 *  plugin bundles inherit one page anatomy — measure, gutter, hero, toolbar row, content surface —
 *  instead of each assembling its own. */
export function WorkspaceShell({ variant = 'register', hero, navigation, toolbar, embedded = false, children, className = '' }: WorkspaceShellProps) {
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
        className={`workspace-shell ${embedded ? 'workspace-shell--embedded' : ''} ${className}`.trim()}
        data-variant={variant}
        data-section-layout={navigation ? 'tabs' : undefined}
      >
        {hero ? <WorkspaceHero {...hero} /> : null}
        {navigation ? <SectionNavigation {...navigation} /> : null}
        <PageToolbar {...toolbar} />
        {content}
      </div>
    </PageToolbarProvider>
  );
}
