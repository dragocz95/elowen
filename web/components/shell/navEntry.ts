/** What the shell navigation is made of, and the one rule for reading it.
 *
 *  This used to live alongside the sidebar's list components. Those are gone — the rail is the only
 *  menu now — but the shape and the active-route rule are not presentation: the plugin registry builds
 *  entries (`lib/pluginNav.ts`), the layout addresses them, and the rail renders them. */
import type { LucideIcon } from 'lucide-react';

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
  activeRoutes?: readonly string[];
  subItems?: readonly NavSubEntry[];
}

/** Whether this entry is the one the reader is currently inside. An entry may name its own routes,
 *  otherwise it answers for its address and for anything nested beneath it — a world is still "here"
 *  when the reader is on one of its pages. */
export function entryIsActive(entry: NavEntry, pathname: string): boolean {
  const routes = entry.activeRoutes
    ?? (entry.href ? [entry.href] : entry.subItems?.map((sub) => sub.href))
    ?? [];
  return routes.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}
