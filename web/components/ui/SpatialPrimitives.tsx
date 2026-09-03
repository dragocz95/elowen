'use client';
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { SettingsGroup, SettingsRow } from './SettingsSurface';

/** Account sections and Settings sections used to be two parallel implementations of the same
 *  label/control form — two sets of class names, two paddings, two hover treatments — which is why the
 *  two pages never quite read as one product. They are ONE now: these keep the account call sites'
 *  vocabulary (`title` rather than `label`) and delegate the rendering, so a change to the section card
 *  lands on both pages at once instead of drifting apart again.
 *
 *  The import points at the settings module deliberately. That file is already the shared home of this
 *  surface — the plugin UI runtime hands those very components to plugin bundles — so lifting the markup
 *  into a third location would recreate the duplication this removed. */
export function SpatialGroup({ title, description, icon, columns = 1, rowId, children, className = '' }: {
  title?: string;
  description?: string;
  icon?: LucideIcon;
  columns?: 1 | 2;
  /** Deep-link anchor — see {@link SettingsGroup}'s `rowId`. */
  rowId?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <SettingsGroup title={title} description={description} icon={icon} columns={columns} rowId={rowId} className={className}>
      {children}
    </SettingsGroup>
  );
}

/** The account page's spelling of {@link SettingsRow}, and the same record: one control, an optional
 *  short status and at most two actions, folding to the same two-line band in a narrow container.
 *  `title` is this surface's word for the row's label and `children` remains an alias of `control`, so
 *  no account call site has to change to reach the canonical anatomy. */
export function SpatialRow({ title, description, hint, icon, control, status, actions, trailingLayout = 'inline', rowId, children, className = '' }: {
  title: string;
  description?: string;
  hint?: string;
  icon?: LucideIcon;
  control?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  trailingLayout?: 'inline' | 'stack';
  /** Deep-link anchor — see {@link SettingsRow}'s `rowId`. */
  rowId?: string;
  /** Alias of `control` — see {@link SettingsRow}. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <SettingsRow
      label={title}
      description={description}
      hint={hint}
      icon={icon}
      control={control ?? children}
      status={status}
      actions={actions}
      trailingLayout={trailingLayout}
      rowId={rowId}
      className={className}
    />
  );
}

/** Short status/identity strip without turning it into a detached card. */
export function SpatialIdentity({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="spatial-identity">
      <div className="min-w-0 flex-1">{children}</div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
