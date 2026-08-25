/** The single source of truth for which prompt templates a user may override, how they group in the
 *  account UI, which `{{vars}}` each one expects (shown as hints so a user doesn't drop a required
 *  placeholder), and whether the model's output is parsed as JSON (so the UI can warn — though the
 *  parser may harden downstream where needed. */

export interface PromptCatalogEntry {
  /** Template name == the `.md` filename without suffix; the override key in `user_prompts`. */
  name: string;
  /** Grouping in the account UI. Core uses advisor|cli; a plugin may extend. */
  group: string;
  /** Placeholders the template substitutes — surfaced in the editor so users keep them intact. */
  vars: string[];
  /** The model output is parsed as JSON downstream; editing this risks the contract (repair softens it). */
  jsonContract: boolean;
  /** The template itself is system-managed: the user's saved text is APPENDED to the default as extra
   *  instructions instead of replacing it (the Elowen advisor identity stays intact). */
  appendOnly?: boolean;
}

export const EDITABLE_PROMPTS: PromptCatalogEntry[] = [
  { name: 'elowen', group: 'advisor', vars: ['userName', 'personality', 'agentName', 'productName'], jsonContract: false, appendOnly: true },
  { name: 'elowen-platform', group: 'advisor', vars: ['ownerName', 'agentName', 'productName'], jsonContract: false, appendOnly: true },
  // A scheduled/unattended turn (any plugin that fires timer-driven work — the bundled cronjob today)
  // gets its OWN focused system prompt instead of the coding-agent base: identity, channel-only delivery,
  // and outcome-reporting rules. Selected by the generic `scheduled` access flag, not any plugin name.
  { name: 'scheduled', group: 'advisor', vars: ['userName', 'personality', 'agentName'], jsonContract: false, appendOnly: true },
  { name: 'cli/plan-mode', group: 'cli', vars: ['planFile', 'planState'], jsonContract: false },
  { name: 'cli/workflow-mode', group: 'cli', vars: [], jsonContract: false },
  // The one-line restatements sent BETWEEN full directives (see turnContextBuilder): a mode's full text
  // costs ~1-2k tokens and the model has already read it, so only entry and every fifth turn resend it.
  // Editable beside their full counterparts so a customised mode keeps both halves in one place.
  { name: 'cli/plan-mode-sparse', group: 'cli', vars: ['planFile'], jsonContract: false },
  { name: 'cli/workflow-mode-sparse', group: 'cli', vars: [], jsonContract: false },
];

const EDITABLE_NAMES = new Set(EDITABLE_PROMPTS.map((p) => p.name));

/** Plugin-contributed catalog entries, swapped in whole on every plugin (re)load. A name colliding with
 *  a core entry is dropped here — the core catalog metadata stays authoritative — while the plugin's
 *  template FILE may still back the name through the prompt-source overlay (transition path for a core
 *  subsystem extracted into a plugin). */
let pluginPrompts: PromptCatalogEntry[] = [];

export function setPluginPromptCatalog(entries: PromptCatalogEntry[]): void {
  pluginPrompts = entries.filter((e) => !EDITABLE_NAMES.has(e.name));
}

/** The full editable-prompt catalog: core entries + plugin contributions (account UI + override API). */
export function editablePrompts(): PromptCatalogEntry[] {
  return [...EDITABLE_PROMPTS, ...pluginPrompts];
}

/** Whether a template name is a user-overridable prompt (guards the override API + resolution path). */
export function isEditablePrompt(name: string): boolean {
  return EDITABLE_NAMES.has(name) || pluginPrompts.some((p) => p.name === name);
}

const APPEND_ONLY = new Set(EDITABLE_PROMPTS.filter((p) => p.appendOnly).map((p) => p.name));

/** True when the user's saved text appends to the default instead of replacing it. */
export function isAppendOnlyPrompt(name: string): boolean {
  return APPEND_ONLY.has(name) || pluginPrompts.some((p) => p.name === name && p.appendOnly === true);
}
