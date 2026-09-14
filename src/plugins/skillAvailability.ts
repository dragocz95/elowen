/** Reserved in-memory marker returned when persisted plugin-skill overrides cannot be trusted.
 * It is never a valid contribution key; the registry interprets it as "disable every plugin skill". */
export const INVALID_PLUGIN_SKILL_OVERRIDES = '\u0000invalid-plugin-skill-overrides';

/** Opaque source identity for a plugin-contributed skill. Plugin and name are both encoded so the key is
 * stable across paths and reloads, while two contributors using the same public name remain independent. */
export function pluginSkillAvailabilityKey(plugin: string, skillName: string): string {
  return `v1:${encodeURIComponent(plugin)}:${encodeURIComponent(skillName)}`;
}
