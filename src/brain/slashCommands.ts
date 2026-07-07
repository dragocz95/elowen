/** THE single source of truth for chat slash commands, shared by every surface (CLI TUI, Discord,
 *  web dock). Each surface renders its command menu from this list and routes execution by `kind`;
 *  the daemon publishes the (identity-filtered) list at `GET /brain/commands` and executes the
 *  server-side ones at `POST /brain/command`. Add a new command HERE only — never per surface. */

export type SlashSurface = 'cli' | 'discord' | 'web';

/** How a surface handles the command once the user picks it:
 *  - `action`: a server-side effect with no chooser (new, stop, compact, restart) — POST /brain/command.
 *  - `info`:   fetch + render data (status, help) — no state change.
 *  - `picker`: opens a surface-local chooser (model, think, and the CLI conversation pickers).
 *  - `mode`:   switches the chat work mode on the local surface; not server-dispatched.
 *  - `prompt`: a plugin-contributed prompt macro — its `prompt` (with `$ARGS`/`$1..$9` substituted) is
 *              sent to the agent as a user turn. */
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
  /** For `kind:'prompt'` (plugin) commands: the prompt template sent to the agent. */
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
  { name: 'skills', description: 'Inspect and manage loaded skills', kind: 'picker', surfaces: ['cli'] },
  { name: 'goal', description: 'Create, inspect, pause, resume or clear a persistent goal', kind: 'action', surfaces: ['cli'] },
  { name: 'subgoal', description: 'Add or remove persistent-goal subgoals', kind: 'action', surfaces: ['cli'] },
  { name: 'tools', description: 'Inspect active plugin tools and ownership', kind: 'picker', surfaces: ['cli'] },
  { name: 'compact', description: 'Summarize the conversation to free up context', kind: 'action' },
  { name: 'plan', description: 'Plan mode — think through the approach before editing', kind: 'mode', surfaces: ['cli'] },
  { name: 'build', description: 'Build mode — implement changes with tools', kind: 'mode', surfaces: ['cli'] },
  // CLI-local like /goal: the TUI calls POST /brain/yolo itself. Session-scoped — the persisted
  // default is edited in web Account → Orca AI (or PATCH /auth/me/permissions).
  { name: 'yolo', description: 'YOLO — auto-approve tool asks for this session ("on"/"off" or toggle)', kind: 'action', surfaces: ['cli'] },
  { name: 'model', description: 'Switch the AI model', kind: 'picker' },
  // CLI-only: the reasoning-effort picker is wired in the TUI. Discord tunes reasoning through its own
  // native command surface; the web dock has no picker for it yet (would show a dead menu entry).
  { name: 'reasoning', description: 'Set the reasoning effort · "show" toggles Thought rows', kind: 'picker', surfaces: ['cli'] },
  { name: 'theme', description: 'Switch the terminal colour theme', kind: 'picker', surfaces: ['cli'] },
  // adminOnly: the toggle flips a daemon-wide LspManager singleton (spawns/kills servers for everyone),
  // so it must be gated to operators — a non-admin must not disable diagnostics for other users.
  { name: 'lsp', description: 'Language diagnostics (LSP) — status, servers and on/off', kind: 'action', surfaces: ['cli'], adminOnly: true },
  { name: 'restart', description: 'Restart the Orca daemon', kind: 'action', adminOnly: true },
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

/** Substitute a prompt command's placeholders with the user's arguments: `$ARGS` → the whole argument
 *  string, `$1`..`$9` → whitespace-split positionals (missing → ''). If the template references none of
 *  them and arguments were given, they are appended on a new line so a bare `/cmd some text` still works. */
export function expandPromptCommand(prompt: string, args: string): string {
  const trimmed = args.trim();
  const positionals = trimmed ? trimmed.split(/\s+/) : [];
  const usesPlaceholders = /\$ARGS\b|\$[1-9]\b/.test(prompt);
  // Single pass with a FUNCTION replacer: it substitutes literally, so `$`-sequences in the user's args
  // (`$$`, `$&`, `$1`) are inserted verbatim, and the output isn't re-scanned by a second `$1..$9` pass.
  let out = prompt.replace(/\$ARGS\b|\$([1-9])\b/g, (_, d: string | undefined) =>
    d ? (positionals[Number(d) - 1] ?? '') : trimmed);
  if (!usesPlaceholders && trimmed) out = `${out}\n\n${trimmed}`;
  return out.trim();
}
