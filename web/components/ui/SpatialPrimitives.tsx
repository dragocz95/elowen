'use client';
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { SettingsGroup, SettingsRow } from '../../modules/settings/SettingsSurface';

/** Account sections and Settings sections used to be two parallel implementations of the same
 *  label/control form — two sets of class names, two paddings, two hover treatments — which is why the
 *  two pages never quite read as one product. They are ONE now: these keep the account call sites'
 *  vocabulary (`title` rather than `label`) and delegate the rendering, so a change to the section card
 *  lands on both pages at once instead of drifting apart again.
 *
 *  The import points at the settings module deliberately. That file is already the shared home of this
 *  surface — the plugin UI runtime hands those very components to plugin bundles — so lifting the markup
 *  into a third location would recreate the duplication this removed. */
export function SpatialGroup({ title, description, icon, columns = 1, children, className = '' }: {
  title?: string;
  description?: string;
  icon?: LucideIcon;
  columns?: 1 | 2;
  children: ReactNode;
  className?: string;
}) {
  return (
    <SettingsGroup title={title} description={description} icon={icon} columns={columns} className={className}>
      {children}
    </SettingsGroup>
  );
}

export function SpatialRow({ title, description, hint, icon, children, className = '' }: {
  title: string;
  description?: string;
  hint?: string;
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
}) {
  return (
    <SettingsRow label={title} description={description} hint={hint} icon={icon} className={className}>
      {children}
    </SettingsRow>
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
