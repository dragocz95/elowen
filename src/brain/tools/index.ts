import { createToolSearchHandle, toolSearchTool } from '../toolSearch/toolSearchTool.js';
import { buildExitPlanModeTool } from './exitPlanMode.js';
import { buildMemoryTools } from './memoryTools.js';
import { buildShareFileTool } from './shareFileTool.js';
import { buildShareImageTool } from './shareImageTool.js';
export type BuiltinToolGroup = 'memory' | 'image' | 'core';

export { buildMemoryTools } from './memoryTools.js';

/** Icons for the brain's BUILT-IN tools — they have no manifest, so this is their co-located icon
 *  declaration (the equivalent of a plugin's manifest `icons`). The daemon merges it with the plugin
 *  manifest icons to resolve a `tool` event's icon. Keys are exact names or `prefix*` patterns. */
export const BUILTIN_TOOL_ICONS: Record<string, string> = {
  // Kept as a PREFIX even though every Elowen* tool now lives in a plugin (work: the task control
  // plane): the icon map is merged with the plugin manifests' own icons and
  // this is the family's historical look, so a tool that moves between owners never changes glyph.
  'Elowen*': '🔥',
  'Memory*': '🧠',
  'ToolSearch': '🧭',
  'ShareImage': '🖼',
  'ShareFile': '📎',
  'ExitPlanMode': '📋',
};

/** Output-visibility policy for the brain's BUILT-IN tools (the co-located equivalent of a plugin
 *  manifest's `showOutput`). Output is HIDDEN by default; only the tools listed here surface their
 *  SUCCESSFUL output in the transcript. The control plane (`Elowen*`) and memory (`Memory*`) are
 *  deliberately ABSENT — they return structured data the model
 *  acts on, not something the reader needs echoed, so their success stays hidden and repeated calls
 *  collapse into one row (a failure or a hook note still surfaces; see `toolOutputView`). Keys are
 *  exact names or `prefix*` patterns. */
/** Core-owned loading defaults for definitions without a bundled manifest. The image implementations
 *  currently arrive through marketplace plugins, but Elowen still owns their default and matches these
 *  names against the actual composed registry; their plugin owner remains the override namespace. */
export const BUILTIN_TOOL_DEFER_LOADING: readonly string[] = ['GenerateImage', 'EditImage'];

export const BUILTIN_TOOL_OUTPUT_SHOWN: string[] = [
  // NOTE: `Lsp*` moved out with the subsystem — the lsp plugin's manifest `showOutput` carries it now.
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
  // Every Elowen* tool lives in a plugin now (ElowenListTasks in `work`, ElowenListMissions/Sessions in
  // external integrations); their manifests' `planSafe` declare them, so the composed plan-mode set is unchanged
  // while the plugins are enabled.
  'MemorySearch', 'MemoryListRecent', 'MemoryCategories',
  // The six Lsp* tools live in the lsp plugin now; its manifest `planSafe` declares them, so the
  // composed plan-mode set is unchanged while the plugin is enabled.
  // Showing the user a screenshot is exactly what planning a UI change needs, and it mutates nothing: the
  // file is copied into the conversation's own image store, nothing the user owns is touched.
  'ShareImage', 'ShareFile',
  // NOTE: ToolSearch is deliberately NOT plan-safe. In plan mode the deferred tools it would fetch are
  // external MCP tools — presumed mutating and refused by the plan-safe boundary anyway — so activating
  // them buys nothing and would only spend tokens on schemas the turn cannot call. Deferred MCP tools
  // being unreachable while planning is the correct, safe behaviour.
];

/** Name/label/group for every BUILT-IN (native, non-plugin) brain tool, derived from the real tool
 *  definitions so it can never drift from what a session actually composes. Used by the users overview
 *  and deferral settings without spinning up a session. The factories touch their dependencies only inside
 *  `execute`, so inert stubs are safe here. Session-only tools use their real factories too: adding metadata
 *  by hand beside them would create a second catalog that can omit or rename one silently. */
export function builtinToolMetas(): { name: string; label: string; description?: string; group: BuiltinToolGroup }[] {
  const meta = (group: BuiltinToolGroup) => (t: { name: string; label?: string; description?: string }) => ({
    name: t.name,
    label: t.label ?? t.name,
    ...(typeof t.description === 'string' ? { description: t.description } : {}),
    group,
  });
  const memory = buildMemoryTools(undefined as never).map(meta('memory'));
  const sharing = [buildShareImageTool(undefined as never), buildShareFileTool(undefined as never)].map(meta('image'));
  const session = [
    toolSearchTool(createToolSearchHandle(new Set())),
    buildExitPlanModeTool(),
  ].map(meta('core'));
  return [...memory, ...sharing, ...session];
}
