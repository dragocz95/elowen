/** THE single source of truth for chat slash commands, shared by every surface (CLI TUI, Discord,
 *  web dock). Each surface renders its command menu from this list and routes execution by `kind`;
 *  the daemon publishes the (identity-filtered) list at `GET /brain/commands` and executes the
 *  server-side ones at `POST /brain/command`. Add a new command HERE only — never per surface. */

import { createSyntheticSourceInfo, type PromptTemplate } from '@earendil-works/pi-coding-agent';

export type SlashSurface = 'cli' | 'discord' | 'web';

/** How a surface handles the command once the user picks it:
 *  - `action`: a server-side effect with no chooser (new, stop, compact, restart) — POST /brain/command.
 *  - `info`:   fetch + render data (status, help) — no state change.
 *  - `picker`: opens a surface-local chooser (model, think, and the CLI conversation pickers).
 *  - `mode`:   switches the chat work mode on the local surface; not server-dispatched.
 *  - `prompt`: a plugin-contributed prompt macro — the surface sends the RAW `/name args` slash and the
 *              daemon feeds it to PI, which expands the template's arguments natively in prompt(). */
type SlashKind = 'action' | 'info' | 'picker' | 'mode' | 'prompt';

export interface SlashCommandDef {
  name: string;
  /** One-line help shown in every surface's menu. English (surfaces localize their own chrome only). */
  description: string;
  kind: SlashKind;
  /** Gated to admins (server-side check is `user.is_admin`). e.g. `restart`. */
  adminOnly?: boolean;
  /** Which surfaces expose it. Omitted → all three. The CLI conversation pickers are CLI-only. */
  surfaces?: SlashSurface[];
  /** For `kind:'prompt'` (plugin) commands: the prompt template. PI expands its argument placeholders
   *  ($1/$@/$ARGUMENTS/${N:-default}) when the raw slash reaches the session — the surface never expands. */
  prompt?: string;
  /** For plugin commands: the owning plugin's name (menu attribution + provenance). */
  plugin?: string;
}

/** The canonical command set. Order is the display order in menus. */
export const SLASH_COMMANDS: readonly SlashCommandDef[] = [
  { name: 'new', description: 'Start a fresh conversation', kind: 'action' },
  { name: 'stop', description: 'Stop the running agent', kind: 'action' },
  { name: 'status', description: 'Session info — model, context and usage', kind: 'info' },
  { name: 'mcp', description: 'Inspect MCP servers, tools and reconnect health', kind: 'picker', surfaces: ['cli'] },
  { name: 'skills', description: 'Inspect and manage loaded skills', kind: 'picker', surfaces: ['cli', 'web'] },
  { name: 'goal', description: 'Create, inspect, pause, resume or clear a persistent goal', kind: 'action', surfaces: ['cli'] },
  { name: 'subgoal', description: 'Add or remove persistent-goal subgoals', kind: 'action', surfaces: ['cli'] },
  { name: 'tools', description: 'Inspect active plugin tools and ownership', kind: 'picker', surfaces: ['cli'] },
  { name: 'compact', description: 'Summarize the conversation to free up context', kind: 'action' },
  { name: 'plan', description: 'Plan mode — think through the approach before editing', kind: 'mode', surfaces: ['cli'] },
  { name: 'build', description: 'Build mode — implement changes with tools', kind: 'mode', surfaces: ['cli'] },
  // CLI-local like /goal: the TUI calls POST /brain/yolo itself. Session-scoped — the persisted
  // default is edited in web Account → Elowen AI (or PATCH /auth/me/permissions).
  { name: 'yolo', description: 'YOLO — auto-approve tool asks for this session ("on"/"off" or toggle)', kind: 'action', surfaces: ['cli'] },
  { name: 'model', description: 'Switch the AI model', kind: 'picker' },
  // CLI-only: the reasoning-effort picker is wired in the TUI. Discord tunes reasoning through its own
  // native command surface; the web dock has no picker for it yet (would show a dead menu entry).
  { name: 'reasoning', description: 'Set the reasoning effort · "show" toggles Thought rows', kind: 'picker', surfaces: ['cli'] },
  { name: 'theme', description: 'Switch the terminal colour theme', kind: 'picker', surfaces: ['cli'] },
  // CLI-local like /theme: reads THIS machine's clipboard (xclip/wl-paste/pngpaste) and parks the
  // image as a pending attachment for the next message — never server-dispatched.
  { name: 'paste', description: 'Attach an image from the system clipboard', kind: 'action', surfaces: ['cli'] },
  // CLI-local like /theme: the TUI suspends itself and round-trips the draft through $VISUAL/$EDITOR.
  { name: 'editor', description: 'Compose the prompt in your $EDITOR', kind: 'picker', surfaces: ['cli'] },
  // adminOnly: the toggle flips a daemon-wide LspManager singleton (spawns/kills servers for everyone),
  // so it must be gated to operators — a non-admin must not disable diagnostics for other users.
  { name: 'lsp', description: 'Language diagnostics (LSP) — status, servers and on/off', kind: 'action', surfaces: ['cli'], adminOnly: true },
  // adminOnly: the toggle flips the daemon-wide `autopilot.tddMode` config (affects every worker the
  // autopilot spawns), so it must be gated to operators — exactly like `/lsp`.
  { name: 'tdd', description: 'TDD mission mode — autopilot workers write a failing test first ("on"/"off" or toggle)', kind: 'action', surfaces: ['cli'], adminOnly: true },
  { name: 'restart', description: 'Restart the Elowen daemon', kind: 'action', adminOnly: true },
  { name: 'help', description: 'Show the available commands', kind: 'info' },
  // CLI-only conversation management (the other surfaces manage conversations through their own UI).
  { name: 'sessions', description: 'Pick a conversation', kind: 'picker', surfaces: ['cli'] },
  { name: 'resume', description: 'Resume a conversation', kind: 'picker', surfaces: ['cli'] },
  { name: 'delete', description: 'Delete a conversation', kind: 'picker', surfaces: ['cli'] },
  { name: 'quit', description: 'Exit', kind: 'action', surfaces: ['cli'] },
];

/** The subset a given surface shows to a given user: surface-scoped, and admin-only commands hidden
 *  from non-operators. This is what `GET /brain/commands` returns and what each surface renders. */
export function commandsFor(surface: SlashSurface, isAdmin: boolean): SlashCommandDef[] {
  return SLASH_COMMANDS.filter(
    (c) => (!c.surfaces || c.surfaces.includes(surface)) && (!c.adminOnly || isAdmin),
  );
}

/** Look up one command by name (any surface). */
export function findCommand(name: string): SlashCommandDef | undefined {
  return SLASH_COMMANDS.find((c) => c.name === name);
}

/** True when `name` is a built-in command — used to refuse a plugin command that would shadow one. */
export function isBuiltinCommand(name: string): boolean {
  return SLASH_COMMANDS.some((c) => c.name === name);
}

/** A plugin-contributed prompt command as a SlashCommandDef, for merging into a surface's menu. */
export interface PluginSlashCommand { name: string; description: string; prompt: string; surfaces?: SlashSurface[]; plugin?: string }
function pluginCommandDef(cmd: PluginSlashCommand): SlashCommandDef {
  return { name: cmd.name, description: cmd.description, kind: 'prompt', prompt: cmd.prompt, surfaces: cmd.surfaces, plugin: cmd.plugin };
}

/** The full menu for a surface/user: built-ins first, then plugin prompt commands (surface-scoped,
 *  built-in names never shadowed). Single source both `/brain/commands` and any test builds from. */
export function commandsWithPlugins(surface: SlashSurface, isAdmin: boolean, pluginCommands: PluginSlashCommand[]): SlashCommandDef[] {
  const base = commandsFor(surface, isAdmin);
  const extra = pluginCommands
    .filter((c) => (!c.surfaces || c.surfaces.includes(surface)) && !isBuiltinCommand(c.name))
    .map(pluginCommandDef);
  return [...base, ...extra];
}

/** Map plugin prompt-command macros onto PI's native `PromptTemplate[]`, fed to a session through the
 *  resource loader's `promptsOverride`. PI then exposes them as `/name` slash commands and expands their
 *  argument placeholders itself ($1/$@/$ARGUMENTS/${N:-default}) inside prompt()/steer()/followUp() — so
 *  no surface (and no daemon path) ever substitutes arguments on its own. Fully in-memory: `filePath` and
 *  `sourceInfo` are synthetic (`db://prompts/<name>`), never read from disk. */
/** True when `text` is a slash invocation PI expands natively — a `/name …` prompt-command template the
 *  session knows, or a `/skill:name …` skill invocation. The daemon then hands the slash to PI RAW (no
 *  per-turn context prefix), because BOTH expansions only trigger when the message STARTS with the slash
 *  (PI's _expandSkillCommand and expandPromptTemplate early-return otherwise). A `/` that matches no
 *  template (or a message that merely mentions a path) is a normal turn and keeps its context. */
export function isPromptCommand(text: string, session: { promptTemplates: ReadonlyArray<{ name: string }> }): boolean {
  if (!text.startsWith('/')) return false;
  if (text.startsWith('/skill:')) return true;
  const name = text.slice(1).split(/\s+/)[0];
  return !!name && session.promptTemplates.some((t) => t.name === name);
}

export function buildPromptTemplates(commands: Iterable<{ name: string; description: string; prompt: string }>): PromptTemplate[] {
  return [...commands].map((c) => {
    const path = `db://prompts/${c.name}`;
    return {
      name: c.name,
      description: c.description,
      content: c.prompt,
      filePath: path,
      sourceInfo: createSyntheticSourceInfo(path, { source: 'plugin', scope: 'user' }),
    };
  });
}
