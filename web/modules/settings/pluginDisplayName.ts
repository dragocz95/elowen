import type { Locale } from '../../lib/i18n';
import type { PluginInfo } from '../../lib/types';

/** What to CALL a plugin on screen: its localized label, the manifest's English label, or — for a plugin
 *  that declares neither — the technical id, exactly as every surface showed before labels existed.
 *
 *  The id keeps its job everywhere it already has one: config keys, control registration, the API mount,
 *  the data directory and stored grants all stay on `name`, and renaming a plugin in the UI must not move
 *  any of them. */
export function pluginDisplayName(plugin: Pick<PluginInfo, 'name' | 'label' | 'i18n'>, locale: Locale): string {
  return plugin.i18n?.[locale]?.label?.trim() || plugin.label?.trim() || plugin.name;
}
