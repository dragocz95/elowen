import type { OrcaToolCtx } from './orcaTools.js';
import { orcaListTasks, orcaCreateTask, orcaPlan, orcaListMissions, orcaListSessions } from './orcaTools.js';

export type { OrcaToolCtx } from './orcaTools.js';
export { buildMemoryTools } from './memoryTools.js';

/** Icons for the brain's BUILT-IN tools — they have no manifest, so this is their co-located icon
 *  declaration (the equivalent of a plugin's manifest `icons`). The daemon merges it with the plugin
 *  manifest icons to resolve a `tool` event's icon. Keys are exact names or `prefix*` patterns. */
export const BUILTIN_TOOL_ICONS: Record<string, string> = {
  'orca_*': '🐋',
  'memory_*': '🧠',
};

/** The brain's Orca capability toolset. Every tool wraps callOrcaApi (single source of truth), so a
 *  new REST endpoint needs no changes here beyond adding one more thin wrapper. */
export function buildOrcaTools(ctx: OrcaToolCtx) {
  return [orcaListTasks(ctx), orcaCreateTask(ctx), orcaPlan(ctx), orcaListMissions(ctx), orcaListSessions(ctx)];
}
