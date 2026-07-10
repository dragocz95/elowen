'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ChevronRight, type LucideIcon } from 'lucide-react';

interface NavSubEntry {
  id: string;
  href: string;
  label: string;
  icon?: LucideIcon;
}

export interface NavEntry {
  id?: string;
  href?: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
  activeRoutes?: readonly string[];
  subItems?: readonly NavSubEntry[];
}

function pathIs(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`);
}

export function NavItem({
  entry,
  active,
  pathname = '',
  collapsed,
  forceSubItems = false,
  side = 'left',
  expandLabel = 'Expand',
  collapseLabel = 'Collapse',
}: {
  entry: NavEntry;
  active: boolean;
  pathname?: string;
  collapsed: boolean;
  forceSubItems?: boolean;
  side?: 'left' | 'right';
  expandLabel?: string;
  collapseLabel?: string;
}) {
  const Icon = entry.icon;
  const badge = entry.badge && entry.badge > 0 ? entry.badge : 0;
  const hasSubItems = !!entry.subItems?.length;
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = !collapsed && hasSubItems && (forceSubItems || (manualOpen ?? active));

  // Returning to an active world should reveal its context even if the user previously folded it.
  useEffect(() => {
    if (active) setManualOpen(null);
  }, [active]);

  const controlClass = `relative flex w-full min-w-0 items-center gap-3 rounded-xl border px-3 py-2.5 text-sm transition-[background-color,border-color,color,transform] duration-200 ${
    active
      ? 'border-accent/25 bg-accent/[0.09] text-text shadow-[inset_0_0_18px_color-mix(in_srgb,var(--color-accent)_5%,transparent)]'
      : 'border-transparent text-text-muted hover:border-border hover:bg-elevated/70 hover:text-text'
  } ${collapsed ? 'justify-center px-0' : ''}`;

  const label = (
    <>
      <span className="relative flex shrink-0 items-center justify-center">
        <Icon size={18} strokeWidth={1.6} aria-hidden />
        {badge > 0 && collapsed ? (
          <span className="absolute -right-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-0.5 text-[9px] font-bold text-black">{badge}</span>
        ) : null}
      </span>
      {!collapsed ? <span className="min-w-0 truncate font-medium">{entry.label}</span> : null}
      {badge > 0 && !collapsed ? (
        <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-warning/15 px-1.5 text-[10px] font-bold text-warning">{badge}</span>
      ) : null}
    </>
  );

  return (
    <div className="group relative px-2 py-0.5">
      <div className="relative flex items-center gap-1">
        {entry.href ? (
          <Link
            href={entry.href}
            title={collapsed ? entry.label : undefined}
            aria-current={hasSubItems
              ? (active || pathIs(pathname, entry.href) ? 'location' : undefined)
              : (pathIs(pathname, entry.href) ? 'page' : active ? 'location' : undefined)}
            aria-haspopup={collapsed && hasSubItems ? 'true' : undefined}
            className={controlClass}
          >
            {label}
          </Link>
        ) : (
          <button
            type="button"
            title={collapsed ? entry.label : undefined}
            aria-expanded={hasSubItems ? (collapsed ? undefined : open) : undefined}
            onClick={() => { if (!forceSubItems) setManualOpen(!open); }}
            className={controlClass}
          >
            {label}
          </button>
        )}

        {!collapsed && hasSubItems && entry.href ? (
          <button
            type="button"
            aria-label={`${open ? collapseLabel : expandLabel}: ${entry.label}`}
            aria-expanded={open}
            onClick={() => { if (!forceSubItems) setManualOpen(!open); }}
            className="absolute right-3 flex h-7 w-7 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface hover:text-text"
          >
            <ChevronRight size={14} className={`transition-transform duration-200 ${open ? 'rotate-90' : ''}`} aria-hidden />
          </button>
        ) : null}

        {!collapsed && hasSubItems && !entry.href ? (
          <ChevronRight size={14} className={`pointer-events-none absolute right-3 text-text-muted transition-transform duration-200 ${open ? 'rotate-90' : ''}`} aria-hidden />
        ) : null}
      </div>

      {open && entry.subItems ? (
        <div className="relative ml-[1.15rem] mt-1 flex flex-col border-l border-border/80 pb-1 pl-3">
          {entry.subItems.map((sub) => {
            const SubIcon = sub.icon;
            const current = pathIs(pathname, sub.href);
            return (
              <Link
                key={sub.id}
                href={sub.href}
                aria-current={current ? 'page' : undefined}
                className={`flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors ${current ? 'bg-elevated text-text' : 'text-text-muted hover:bg-elevated/60 hover:text-text'}`}
              >
                {SubIcon ? <SubIcon size={14} strokeWidth={1.6} className="shrink-0" aria-hidden /> : null}
                <span className="truncate">{sub.label}</span>
              </Link>
            );
          })}
        </div>
      ) : null}

      {collapsed ? (
        <div
          role={hasSubItems ? 'group' : 'tooltip'}
          className={`invisible absolute top-0 z-[70] min-w-44 translate-x-1 rounded-xl border border-border bg-surface/95 p-1.5 opacity-0 shadow-xl backdrop-blur-xl transition-[opacity,transform,visibility] duration-150 group-hover:visible group-hover:translate-x-0 group-hover:opacity-100 group-focus-within:visible group-focus-within:translate-x-0 group-focus-within:opacity-100 ${side === 'right' ? 'right-full mr-2' : 'left-full ml-2'}`}
          aria-label={entry.label}
        >
          <div className="px-2.5 py-1.5 text-xs font-semibold text-text">{entry.label}</div>
          {entry.subItems?.map((sub) => {
            const SubIcon = sub.icon;
            const current = pathIs(pathname, sub.href);
            return (
              <Link
                key={sub.id}
                href={sub.href}
                aria-current={current ? 'page' : undefined}
                className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs transition-colors ${current ? 'bg-accent/10 text-text' : 'text-text-muted hover:bg-elevated hover:text-text'}`}
              >
                {SubIcon ? <SubIcon size={14} strokeWidth={1.6} aria-hidden /> : null}
                {sub.label}
              </Link>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
