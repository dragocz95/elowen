import type { LucideIcon } from 'lucide-react';
import { pluginLucideIcon } from '../../lib/pluginIcons';
import type { PluginUiListing } from '../../lib/types';

/** Section-id namespace for plugin-contributed Settings sections. Colon-separated so a plugin id can
 *  never collide with a core category, and prefix-checkable BEFORE the listing loads (localStorage /
 *  URL restore validates by shape, the listing then confirms the section still exists). */
const PLUGIN_SETTINGS_SECTION_PREFIX = 'plugin:';

export interface PluginSettingsSection {
  /** Deck section id: `plugin:<plugin>:<settingId>`. */
  id: string;
  plugin: string;
  settingId: string;
  label: string;
  icon: LucideIcon;
}

export const isPluginSettingsSectionId = (id: string): boolean => id.startsWith(PLUGIN_SETTINGS_SECTION_PREFIX);

/** Map the /plugins/ui listing to Settings deck sections — appended AFTER the core sections, one per
 *  manifest `web.settings` entry. Labels arrive localized from the daemon; icons resolve through the
 *  same curated lucide name-map as plugin nav. Pure so the mapping is unit-testable. */
export function pluginSettingsSections(listing: PluginUiListing[]): PluginSettingsSection[] {
  return listing.flatMap((p) => p.settings.map((s) => ({
    id: `${PLUGIN_SETTINGS_SECTION_PREFIX}${p.name}:${s.id}`,
    plugin: p.name,
    settingId: s.id,
    label: s.label,
    icon: pluginLucideIcon(s.icon),
  })));
}
