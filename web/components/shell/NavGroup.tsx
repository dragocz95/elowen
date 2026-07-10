'use client';
import type { NavEntry } from './NavItem';
import { NavItem } from './NavItem';

export interface NavGroupData { label: string; items: NavEntry[] }

function entryIsActive(entry: NavEntry, pathname: string): boolean {
  const routes = entry.activeRoutes
    ?? (entry.href ? [entry.href] : entry.subItems?.map((sub) => sub.href))
    ?? [];
  return routes.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

export function NavGroup({
  group,
  pathname,
  collapsed,
  forceSubItems = false,
  side = 'left',
  expandLabel,
  collapseLabel,
}: {
  group: NavGroupData;
  pathname: string;
  collapsed: boolean;
  forceSubItems?: boolean;
  side?: 'left' | 'right';
  expandLabel?: string;
  collapseLabel?: string;
}) {
  return (
    <div className="flex flex-col py-1">
      {!collapsed ? <span className="px-4 pb-1.5 pt-2 font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-text-muted/70">{group.label}</span> : null}
      {group.items.map((entry) => (
        <NavItem
          key={entry.id ?? entry.href ?? entry.label}
          entry={entry}
          active={entryIsActive(entry, pathname)}
          pathname={pathname}
          collapsed={collapsed}
          forceSubItems={forceSubItems}
          side={side}
          expandLabel={expandLabel}
          collapseLabel={collapseLabel}
        />
      ))}
    </div>
  );
}
