import type { ElowenToolCtx } from './elowenTools.js';
import { elowenListTasks, elowenCreateTask, elowenUpdateTask, elowenPlan, elowenGetTask, elowenStopTask, elowenTaskOutput } from './elowenTools.js';
import { buildMemoryTools } from './memoryTools.js';
import { buildLspTools } from './lspTools.js';
import { buildShareImageTool } from './shareImageTool.js';
export type BuiltinToolGroup = 'elowen' | 'memory' | 'image';

export type { ElowenToolCtx } from './elowenTools.js';
export { buildMemoryTools } from './memoryTools.js';

/** Icons for the brain's BUILT-IN tools — they have no manifest, so this is their co-located icon
 *  declaration (the equivalent of a plugin's manifest `icons`). The daemon merges it with the plugin
 *  manifest icons to resolve a `tool` event's icon. Keys are exact names or `prefix*` patterns. */
export const BUILTIN_TOOL_ICONS: Record<string, string> = {
  'Elowen*': '🔥',
  'Memory*': '🧠',
  'Lsp*': '🔎',
  'ToolSearch': '🧭',
  'ShareImage': '🖼',
  'ExitPlanMode': '📋',
  // Not a real tool: the display name a skill-file Read is RENAMED to on the `tool` event (see
  // toolDisplay in messageView.ts), so the stamped icon matches what clients render.
  'Skill': '📚',
};

/** Output-visibility policy for the brain's BUILT-IN tools (the co-located equivalent of a plugin
 *  manifest's `showOutput`). Output is HIDDEN by default; only the tools listed here surface their
 *  SUCCESSFUL output in the transcript. `Lsp*` diagnostics are worth showing. The control plane
 *  (`Elowen*`) and memory (`Memory*`) are deliberately ABSENT — they return structured data the model
 *  acts on, not something the reader needs echoed, so their success stays hidden and repeated calls
 *  collapse into one row (a failure or a hook note still surfaces; see `toolOutputView`). Keys are
 *  exact names or `prefix*` patterns. */
/** Core-owned loading defaults for definitions without a bundled manifest. The image implementations
 *  currently arrive through marketplace plugins, but Elowen still owns their default and matches these
 *  names against the actual composed registry; their plugin owner remains the override namespace. */
export const BUILTIN_TOOL_DEFER_LOADING: readonly string[] = ['GenerateImage', 'EditImage'];

export const BUILTIN_TOOL_OUTPUT_SHOWN: string[] = [
  'Lsp*',
  // NOTE: ExitPlanMode is deliberately absent. Its result text is an instruction addressed to the MODEL
  // ("stop here and wait"); the part worth showing is the plan, which travels separately as the `plan`
  // field on the tool event and gets its own panel.
];

/** Which of the brain's BUILT-IN tools only READ (the co-located equivalent of a plugin manifest's
 *  `planSafe`). Plan mode composes exactly these plus the plugins' declared ones and withholds the rest,
 *  so this list is a policy boundary: a name added here is a name plan mode will hand the model.
 *  Deliberately NOT `prefix*` patterns, unlike the icon/output lists above — `Elowen*` reads AND writes
 *  (ElowenCreateTask), `Memory*` likewise (MemoryDelete), so only exact names can be right. */
export const BUILTIN_TOOL_PLAN_SAFE: string[] = [
  // ElowenListMissions/ElowenListSessions live in the agents plugin now; its manifest `planSafe`
  // declares them, so the composed plan-mode set is unchanged while the plugin is enabled.
  'ElowenListTasks',
  'MemorySearch', 'MemoryListRecent', 'MemoryCategories',
  'LspDiagnostics', 'LspGoToDefinition', 'LspFindReferences', 'LspHover', 'LspDocumentSymbol', 'LspWorkspaceSymbol',
  // Showing the user a screenshot is exactly what planning a UI change needs, and it mutates nothing: the
  // file is copied into the conversation's own image store, nothing the user owns is touched.
  'ShareImage',
  // NOTE: ToolSearch is deliberately NOT plan-safe. In plan mode the deferred tools it would fetch are
  // external MCP tools — presumed mutating and refused by the plan-safe boundary anyway — so activating
  // them buys nothing and would only spend tokens on schemas the turn cannot call. Deferred MCP tools
  // being unreachable while planning is the correct, safe behaviour.
];

/** The brain's Elowen capability toolset. Every tool wraps callElowenApi (single source of truth), so a
 *  new REST endpoint needs no changes here beyond adding one more thin wrapper. Bundles the LSP
 *  diagnostics tool (owner-chat only, like the Elowen* control plane). */
export function buildElowenTools(ctx: ElowenToolCtx) {
  return [elowenListTasks(ctx), elowenCreateTask(ctx), elowenUpdateTask(ctx), elowenPlan(ctx), elowenGetTask(ctx), elowenStopTask(ctx), elowenTaskOutput(ctx), ...buildLspTools()];
}

/** Name/label/group for every BUILT-IN (native, non-plugin) brain tool, derived from the real tool
 *  definitions so it can never drift from what a session actually composes. Used by the users overview
 *  to list a user's effective tools without spinning up a session. The tool factories only touch their
 *  deps inside `execute`, so passing a stub here is safe — we read only the static name/label. */
export function builtinToolMetas(): { name: string; label: string; group: BuiltinToolGroup }[] {
  const meta = (group: BuiltinToolGroup) => (t: { name: string; label?: string }) => ({ name: t.name, label: t.label ?? t.name, group });
  const elowen = buildElowenTools({ url: '', token: '' }).map(meta('elowen'));
  const memory = buildMemoryTools(undefined as never).map(meta('memory'));
  // Its own group because neither of the others describes it: the control plane is admin-only, memory is
  // per-user, and sharing an image is simply something every interactive session can do.
  const share = [buildShareImageTool(undefined as never)].map(meta('image'));
  return [...elowen, ...memory, ...share];
}
