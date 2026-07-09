import type { ElowenToolCtx } from './elowenTools.js';
import { elowenListTasks, elowenCreateTask, elowenPlan, elowenListMissions, elowenListSessions } from './elowenTools.js';
import { buildMemoryTools } from './memoryTools.js';
import { buildLspTools } from './lspTools.js';

export type { ElowenToolCtx } from './elowenTools.js';
export { buildMemoryTools } from './memoryTools.js';

/** Icons for the brain's BUILT-IN tools — they have no manifest, so this is their co-located icon
 *  declaration (the equivalent of a plugin's manifest `icons`). The daemon merges it with the plugin
 *  manifest icons to resolve a `tool` event's icon. Keys are exact names or `prefix*` patterns. */
export const BUILTIN_TOOL_ICONS: Record<string, string> = {
  'elowen_*': '🔥',
  'memory_*': '🧠',
  'lsp_*': '🔎',
};

/** Output-visibility policy for the brain's BUILT-IN tools (the co-located equivalent of a plugin
 *  manifest's `showOutput`). Output is HIDDEN by default; only the tools listed here surface their
 *  SUCCESSFUL output in the transcript. `lsp_*` diagnostics are worth showing. The control plane
 *  (`elowen_*`) and memory (`memory_*`) are deliberately ABSENT — they return structured data the model
 *  acts on, not something the reader needs echoed, so their success stays hidden and repeated calls
 *  collapse into one row (a failure or a hook note still surfaces; see `toolOutputView`). Keys are
 *  exact names or `prefix*` patterns. */
export const BUILTIN_TOOL_OUTPUT_SHOWN: string[] = [
  'lsp_*',
];

/** The brain's Elowen capability toolset. Every tool wraps callElowenApi (single source of truth), so a
 *  new REST endpoint needs no changes here beyond adding one more thin wrapper. Bundles the LSP
 *  diagnostics tool (owner-chat only, like the elowen_* control plane). */
export function buildElowenTools(ctx: ElowenToolCtx) {
  return [elowenListTasks(ctx), elowenCreateTask(ctx), elowenPlan(ctx), elowenListMissions(ctx), elowenListSessions(ctx), ...buildLspTools()];
}

/** Name/label/group for every BUILT-IN (native, non-plugin) brain tool, derived from the real tool
 *  definitions so it can never drift from what a session actually composes. Used by the users overview
 *  to list a user's effective tools without spinning up a session. The tool factories only touch their
 *  deps inside `execute`, so passing a stub here is safe — we read only the static name/label. */
export function builtinToolMetas(): { name: string; label: string; group: 'elowen' | 'memory' }[] {
  const meta = (group: 'elowen' | 'memory') => (t: { name: string; label?: string }) => ({ name: t.name, label: t.label ?? t.name, group });
  const elowen = buildElowenTools({ url: '', token: '' }).map(meta('elowen'));
  const memory = buildMemoryTools(undefined as never).map(meta('memory'));
  return [...elowen, ...memory];
}
