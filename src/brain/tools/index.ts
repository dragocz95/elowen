import type { OrcaToolCtx } from './orcaTools.js';
import { orcaListTasks, orcaCreateTask, orcaPlan, orcaListMissions, orcaListSessions } from './orcaTools.js';
import { buildMemoryTools } from './memoryTools.js';
import { buildLspTools } from './lspTools.js';

export type { OrcaToolCtx } from './orcaTools.js';
export { buildMemoryTools } from './memoryTools.js';

/** Icons for the brain's BUILT-IN tools — they have no manifest, so this is their co-located icon
 *  declaration (the equivalent of a plugin's manifest `icons`). The daemon merges it with the plugin
 *  manifest icons to resolve a `tool` event's icon. Keys are exact names or `prefix*` patterns. */
export const BUILTIN_TOOL_ICONS: Record<string, string> = {
  'orca_*': '🐋',
  'memory_*': '🧠',
  'lsp_*': '🔎',
};

/** The brain's Orca capability toolset. Every tool wraps callOrcaApi (single source of truth), so a
 *  new REST endpoint needs no changes here beyond adding one more thin wrapper. Bundles the LSP
 *  diagnostics tool (owner-chat only, like the orca_* control plane). */
export function buildOrcaTools(ctx: OrcaToolCtx) {
  return [orcaListTasks(ctx), orcaCreateTask(ctx), orcaPlan(ctx), orcaListMissions(ctx), orcaListSessions(ctx), ...buildLspTools()];
}

/** Name/label/group for every BUILT-IN (native, non-plugin) brain tool, derived from the real tool
 *  definitions so it can never drift from what a session actually composes. Used by the users overview
 *  to list a user's effective tools without spinning up a session. The tool factories only touch their
 *  deps inside `execute`, so passing a stub here is safe — we read only the static name/label. */
export function builtinToolMetas(): { name: string; label: string; group: 'orca' | 'memory' }[] {
  const meta = (group: 'orca' | 'memory') => (t: { name: string; label?: string }) => ({ name: t.name, label: t.label ?? t.name, group });
  const orca = buildOrcaTools({ url: '', token: '' }).map(meta('orca'));
  const memory = buildMemoryTools(undefined as never).map(meta('memory'));
  return [...orca, ...memory];
}
