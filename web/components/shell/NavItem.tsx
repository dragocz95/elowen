'use client';
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';

export interface NavEntry { href: string; label: string; icon: LucideIcon }

export function NavItem({ entry, active, collapsed }: { entry: NavEntry; active: boolean; collapsed: boolean }) {
  const Icon = entry.icon;
  return (
    <Link
      href={entry.href}
      title={collapsed ? entry.label : undefined}
      aria-current={active ? 'page' : undefined}
      className={`flex items-center gap-3 border-l-2 px-3 py-2 text-sm transition-colors ${active ? 'border-accent text-text' : 'border-transparent text-text-muted hover:text-text'}${collapsed ? ' justify-center' : ''}`.trim()}
    >
      <Icon size={16} strokeWidth={1.5} aria-hidden />
      {!collapsed && <span className="uppercase tracking-wide text-xs">{entry.label}</span>}
    </Link>
  );
}
