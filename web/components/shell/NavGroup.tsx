'use client';
import type { NavEntry } from './NavItem';
import { NavItem } from './NavItem';

export interface NavGroupData { label: string; items: NavEntry[] }

export function NavGroup({ group, pathname, collapsed }: { group: NavGroupData; pathname: string; collapsed: boolean }) {
  return (
    <div className="flex flex-col py-1">
      {!collapsed && <span className="px-3 py-1 font-mono text-tiny uppercase tracking-widest text-text-muted">{group.label}</span>}
      {group.items.map((entry) => (
        <NavItem key={entry.href} entry={entry} active={pathname === entry.href} collapsed={collapsed} />
      ))}
    </div>
  );
}
