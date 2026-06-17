'use client';
import type { NavGroupData } from '../../lib/nav';
import { NavItem } from './NavItem';

export function NavGroup({ group, pathname, collapsed }: { group: NavGroupData; pathname: string; collapsed: boolean }) {
  return (
    <div className="flex flex-col py-1">
      {!collapsed && <span className="px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-text-muted">{group.label}</span>}
      {group.items.map((entry) => (
        <NavItem key={entry.href} entry={entry} active={pathname === entry.href} collapsed={collapsed} />
      ))}
    </div>
  );
}
