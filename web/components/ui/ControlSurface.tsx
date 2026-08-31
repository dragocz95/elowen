'use client';
import type { HTMLAttributes, ReactNode } from 'react';
import { PageToolbarContribution, type PageToolbarProps } from './PageToolbar';
import { WorkspaceLeadPortal } from './WorkspaceShell';

export function ControlSurfaceDocument({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section data-control-surface className={`control-surface-document ${className}`}>{children}</section>;
}

/** How a register toolbar arranges what it holds.
 *
 *  `inline` — one wrapping row of controls, vertically centred. A search field, a filter or two, maybe a
 *    button: the ordinary case, and the only one three of the five call sites ever wanted.
 *  `split`  — the same row with its ends pushed apart, stacking when the container is too narrow to hold
 *    both. For a toolbar that carries a heading on one side and its controls on the other.
 *  `stacked` — a column of BANDS rather than a row of controls. For a toolbar whose first band is the
 *    filters you always see and whose second is a disclosure panel that opens under it.
 *
 *  It is a typed property and not a class for one concrete reason. The toolbar's layout is declared in
 *  `app/styles/components/control-surface.css`, which is imported UNLAYERED — so it outranks the whole of
 *  Tailwind's `@layer utilities` whatever the specificity — and a caller passing `flex-col items-stretch`
 *  was writing a declaration that could only win by luck. Two call sites did exactly that; a third passed
 *  `flex-wrap`, which the stylesheet already said. Naming the three arrangements puts them where the rest
 *  of the layout lives, and a design that wants to retune one has something to address. */
type ControlSurfaceToolbarLayout = 'inline' | 'split' | 'stacked';

interface ControlSurfaceToolbarBase {
  layout?: ControlSurfaceToolbarLayout;
  className?: string;
  testId?: string;
}

type LegacyControlSurfaceToolbarProps = ControlSurfaceToolbarBase & {
  children: ReactNode;
  search?: never;
  filters?: never;
  actions?: never;
  /** Promote the page's primary filters into the canonical toolbar row. */
  promote?: boolean;
};

type StructuredControlSurfaceToolbarProps = PageToolbarProps & {
  /** Structured search/filter/action contributions are page-level by definition. */
  promote?: true;
  layout?: never;
  className?: never;
  testId?: never;
};

export type ControlSurfaceToolbarProps = LegacyControlSurfaceToolbarProps | StructuredControlSurfaceToolbarProps;

export function ControlSurfaceToolbar({
  children, search, filters, actions, layout = 'inline', className = '', testId, promote = true,
}: ControlSurfaceToolbarProps) {
  if (search !== undefined || filters !== undefined || actions !== undefined) {
    return <PageToolbarContribution search={search} filters={filters} actions={actions}>{children}</PageToolbarContribution>;
  }
  const toolbar = <div className={`control-surface-toolbar ${className}`} data-layout={layout} data-testid={testId}>{children}</div>;
  return promote ? <WorkspaceLeadPortal>{toolbar}</WorkspaceLeadPortal> : toolbar;
}

export function ControlSurfaceRegister({ children, className = '', ...rest }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return <div className={`control-surface-register ${className}`} {...rest}>{children}</div>;
}

export function ControlSurfaceState({ children, tone = 'default', className = '' }: { children: ReactNode; tone?: 'default' | 'danger'; className?: string }) {
  return <div className={`control-surface-state ${className}`} data-tone={tone}>{children}</div>;
}
