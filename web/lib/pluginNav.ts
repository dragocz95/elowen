import { pluginLucideIcon } from './pluginIcons';
import type { PluginUiListing } from './types';
import type { NavEntry } from '../components/shell/NavItem';

/** Map the /plugins/ui listing to sidebar worlds: one world per plugin with nav entries, first nav item
 *  as the world's face, the rest as sub-items. A plugin with no nav contributes nothing — its pages
 *  stay reachable by URL, it just claims no menu space. Pure so the mapping is unit-testable. */
export function pluginNavEntries(listing: PluginUiListing[]): NavEntry[] {
  return listing.filter((p) => p.nav.length > 0).map((p) => {
    const base = `/p/${p.name}`;
    const href = (route?: string) => (route ? `${base}/${route}` : base);
    const first = p.nav[0]!;
    return {
      id: `plugin-${p.name}`,
      href: href(first.route),
      label: first.label,
      icon: pluginLucideIcon(first.icon),
      activeRoutes: [base],
      subItems: p.nav.length > 1
        ? p.nav.map((item, i) => ({
          id: `plugin-${p.name}-${i}`,
          href: href(item.route),
          label: item.label,
          icon: pluginLucideIcon(item.icon),
        }))
        : undefined,
    };
  });
}
