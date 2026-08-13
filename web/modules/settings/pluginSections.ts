/** Section-id namespace for plugin-contributed Settings sections. Colon-separated so a plugin id can
 *  never collide with a core category, and prefix-checkable BEFORE the listing loads (localStorage /
 *  URL restore validates by shape, the listing then confirms the section still exists).
 *
 *  The Settings deck itself is CORE-ONLY: a plugin's settings section is a page of that plugin's world,
 *  which is where the menu already points. These ids survive only as remembered categories and old
 *  links (`/settings?cat=plugin:skills:skills`), which the Settings page forwards to that page. */
const PLUGIN_SETTINGS_SECTION_PREFIX = 'plugin:';

export const isPluginSettingsSectionId = (id: string): boolean => id.startsWith(PLUGIN_SETTINGS_SECTION_PREFIX);

/** Split `plugin:<plugin>:<settingId>` back into its parts. Returns null for anything else, including a
 *  malformed id with an empty half — a bookmark is user input and must not resolve to `/p//settings/`. */
export function parsePluginSettingsSectionId(id: string): { plugin: string; settingId: string } | null {
  if (!isPluginSettingsSectionId(id)) return null;
  const [, plugin, settingId] = id.split(':');
  return plugin && settingId ? { plugin, settingId } : null;
}
