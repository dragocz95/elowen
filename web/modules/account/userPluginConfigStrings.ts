import type { UserPluginConfigDetail } from '../../lib/types';

/** The two strings a per-account plugin config contributes to Account, resolved in ONE place so the rail
 *  entry and the panel header can never disagree about what the plugin is called.
 *
 *  They are deliberately different kinds of string. `label` is a NAME — "GitHub", "Raynet CRM" — and it is
 *  what the rail shows, where there is room for a few words and nothing else. `description` is a sentence
 *  about the plugin and belongs in the selected panel, where it can wrap. The rail used to render the
 *  description, which is how a whole English sentence ended up as a menu title.
 *
 *  Locale resolution goes through the plugin's own `i18n/<lang>.json` (served on the detail as `i18n`),
 *  the same machinery every other plugin manifest string uses. A plugin that ships a translation for the
 *  active locale wins outright — no English is mixed in beside it. */

/** Short name for the plugin's per-account settings entry. Falls back to the plugin id rather than to the
 *  description, so a plugin that declares no label is short and dull instead of long and wrong. */
export function userPluginConfigLabel(detail: UserPluginConfigDetail, locale: string): string {
  return detail.i18n?.[locale]?.userConfigLabel?.trim()
    || detail.label?.trim()
    || detail.name;
}

/** The localized sentence for the hero and the panel header. Undefined when the plugin ships none — the
 *  caller then uses the host's generic caption rather than repeating the label. */
export function userPluginConfigDescription(detail: UserPluginConfigDetail, locale: string): string | undefined {
  return detail.i18n?.[locale]?.description?.trim()
    || detail.description?.trim()
    || undefined;
}
