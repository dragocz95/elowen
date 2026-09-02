import { pluginLucideIcon } from './pluginIcons';
import type { PluginUiListing } from './types';
import type { NavEntry } from '../components/shell/navEntry';

/** Where a plugin's settings section lives. Sections are pages of the plugin's own world — Settings is
 *  core-only — so this is the one rule that decides their address, shared by the menu and by every
 *  redirect that still points at the old Settings deck id.
 *
 *  A plugin whose whole UI is one settings section lives at `/p/<plugin>`: spelling it out as
 *  `/p/skills/settings/skills` repeats the plugin's own name back at the reader. The host route still
 *  serves the explicit form, so existing links and multi-section plugins keep working. */
export function pluginSectionHref(p: PluginUiListing, settingId: string): string {
  const base = `/p/${p.name}`;
  return p.nav.length === 0 && p.settings.length === 1 ? base : `${base}/settings/${settingId}`;
}

/** Map the /plugins/ui listing to sidebar worlds: one world per plugin, its first page as the world's
 *  face and the rest as sub-items.
 *
 *  A plugin's pages are BOTH its `web.nav` pages and its `web.settings` sections: the host route serves a
 *  settings section as a standalone page at `/p/<plugin>/settings/<id>`, so a plugin whose whole UI is a
 *  settings section is a plugin with a page — it just used to be reachable only through the Settings deck.
 *  The deck keeps its sections; this only adds the direct way in. A plugin contributing neither claims no
 *  menu space. Pure so the mapping is unit-testable.
 *
 *  A section placed `pluginDetail` is deliberately absent from this mapping: it configures a capability
 *  the assistant already ships rather than opening a world of its own, so it belongs where the operator
 *  installs and tunes that plugin. Filtering HERE covers the sidebar and the command palette at once —
 *  they read the same entries — and leaves the section's own address untouched for anything that links
 *  to it. A plugin whose every surface is placed there claims no menu space at all. */
export function pluginNavEntries(listing: PluginUiListing[]): NavEntry[] {
  return listing.flatMap((p) => {
    const base = `/p/${p.name}`;
    const pages = [
      ...p.nav.map((item) => ({ href: item.route ? `${base}/${item.route}` : base, label: item.label, icon: item.icon })),
      ...p.settings.filter((s) => s.placement !== 'pluginDetail')
        .map((s) => ({ href: pluginSectionHref(p, s.id), label: s.label, icon: s.icon })),
    ];
    const first = pages[0];
    if (!first) return [];
    return [{
      id: `plugin-${p.name}`,
      href: first.href,
      // A plugin contributing several peer pages names its own world; without a name the world borrows
      // the first page's, which then reads as if that page stood over its siblings.
      label: p.label ?? first.label,
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
