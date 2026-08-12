import { pluginLucideIcon } from './pluginIcons';
import type { PluginUiListing } from './types';
import type { NavEntry } from '../components/shell/NavItem';

/** Map the /plugins/ui listing to sidebar worlds: one world per plugin, its first page as the world's
 *  face and the rest as sub-items.
 *
 *  A plugin's pages are BOTH its `web.nav` pages and its `web.settings` sections: the host route serves a
 *  settings section as a standalone page at `/p/<plugin>/settings/<id>`, so a plugin whose whole UI is a
 *  settings section is a plugin with a page — it just used to be reachable only through the Settings deck.
 *  The deck keeps its sections; this only adds the direct way in. A plugin contributing neither claims no
 *  menu space. Pure so the mapping is unit-testable. */
export function pluginNavEntries(listing: PluginUiListing[]): NavEntry[] {
  return listing.flatMap((p) => {
    const base = `/p/${p.name}`;
    const pages = [
      ...p.nav.map((item) => ({ href: item.route ? `${base}/${item.route}` : base, label: item.label, icon: item.icon })),
      ...p.settings.map((s) => ({ href: `${base}/settings/${s.id}`, label: s.label, icon: s.icon })),
    ];
    const first = pages[0];
    if (!first) return [];
    return [{
      id: `plugin-${p.name}`,
      href: first.href,
      label: first.label,
      icon: pluginLucideIcon(first.icon),
      activeRoutes: [base],
      subItems: pages.length > 1
        ? pages.map((page, i) => ({
          id: `plugin-${p.name}-${i}`,
          href: page.href,
          label: page.label,
          icon: pluginLucideIcon(page.icon),
        }))
        : undefined,
    }];
  });
}
