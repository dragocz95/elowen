/** THE single source of truth for chat slash commands, shared by every surface (CLI TUI, Discord,
 *  web dock). Each surface renders its command menu from this list and routes execution by `kind`;
 *  the daemon publishes the (identity-filtered) list at `GET /brain/commands` and executes the
 *  server-side ones at `POST /brain/command`. Add a new command HERE only — never per surface. */

import { createSyntheticSourceInfo, type PromptTemplate } from '@earendil-works/pi-coding-agent';
// SlashCommandDef/SlashSurface live in the shared wire contract so the web dock's menu can't drift from
// this canonical list. Re-exported here for the daemon/CLI importers that expect them.
import type { SlashCommandDef, SlashSurface } from '../shared/wireContract.js';

export type { SlashCommandDef, SlashSurface };

/** The canonical command set. Order is the display order in menus. */
export const SLASH_COMMANDS: readonly SlashCommandDef[] = [
  { name: 'new', description: 'Start a fresh conversation', kind: 'action' },
  // Empties THIS conversation (history, markers, cards and the live context) without starting a new one —
  // the id, title, model and every attached client stay. CLI + web only: the dispatcher resolves the
  // caller's own conversation, and a shared channel has no such conversation to clear.
  { name: 'clear', description: 'Clear this conversation and start from an empty context', kind: 'action', surfaces: ['cli', 'web'] },
  { name: 'stop', description: 'Stop the running agent', kind: 'action' },
  // CHAT PLATFORMS ONLY. `/stats` below is the single session-info command on the CLI and the web dock,
  // and it is a superset of what this ever showed there. The platforms keep `/status` because their
  // one-line answer is rendered by the adapters' own shared control core (CONTROL_COMMANDS in
  // packages/plugin-shared/chatCommands.mjs, plus Telegram's BotFather list), which has no way to draw the
  // /stats overlay — dropping it there would leave a chat channel with no session info at all.
  { name: 'status', description: 'Session info — model, context and usage', kind: 'info', surfaces: ['discord', 'whatsapp', 'telegram', 'msteams'] },
  // The ONE session-info command on the CLI and the web dock: conversation usage, per-model totals and the
  // context breakdown, plus the session rows (model, reasoning, mode, project, goal) `/status` used to own.
  { name: 'stats', description: 'Usage stats — this conversation and per-model totals', kind: 'info', surfaces: ['cli', 'web'] },
  // CLI-only: the /stats overlay opened straight on its context-breakdown section. The name is
  // deliberately shared with the channel re-key `context` further down, which is explicitly absent from
  // the CLI — every surface renders and dispatches from `commandsFor`, and no surface ever sees both.
  { name: 'context', description: 'Context breakdown — what is filling the window', kind: 'info', surfaces: ['cli'] },
  // Both are core commands whose entire payload comes from a plugin's routes, so both carry
  // `requiresPlugin` and vanish from the menu when that plugin is not running.
  { name: 'mcp', description: 'Inspect MCP servers, tools and reconnect health', kind: 'picker', surfaces: ['cli'], requiresPlugin: 'mcp' },
  { name: 'skills', description: 'Inspect and manage loaded skills', kind: 'picker', surfaces: ['cli', 'web'], requiresPlugin: 'skills' },
  { name: 'goal', description: 'Create, inspect, pause, resume or clear a persistent goal', kind: 'action', surfaces: ['cli'] },
  { name: 'subgoal', description: 'Add or remove persistent-goal subgoals', kind: 'action', surfaces: ['cli'] },
  { name: 'tools', description: 'Inspect active plugin tools and ownership', kind: 'picker', surfaces: ['cli'] },
  { name: 'compact', description: 'Summarize the conversation to free up context (add text to steer what to keep)', kind: 'action' },
  // CLI + web dock: both keep the chosen mode in their own session state and stamp it on every send
  // (`mode` on POST /brain/send), so there is no server-side mode to switch. The chat platforms have no
  // place to show which mode a channel is in, so they stay out.
  { name: 'plan', description: 'Plan mode — think through the approach before editing', kind: 'mode', surfaces: ['cli', 'web'] },
  { name: 'build', description: 'Build mode — implement changes with tools', kind: 'mode', surfaces: ['cli', 'web'] },
  { name: 'workflow', description: 'Workflow mode — orchestrate the task as a DAG of sub-agents', kind: 'mode', surfaces: ['cli', 'web'] },
  // CLI-local like /goal: the TUI calls POST /brain/yolo itself. Session-scoped — the persisted
  // default is edited in web Account → Elowen AI (or PATCH /auth/me/permissions).
  { name: 'yolo', description: 'YOLO — auto-approve tool asks for this session ("on"/"off" or toggle)', kind: 'action', surfaces: ['cli'] },
  { name: 'model', description: 'Switch the AI model', kind: 'picker' },
  // Move (not fork) one of the caller's own conversations INTO this channel/thread so the bot continues in
  // it. A `picker` (not `action`), so it is never server-dispatched through POST /brain/command — its
  // dedicated endpoint is POST /brain/context. Absent from the CLI and the web dock: neither is a shared
  // channel to re-key — the CLI's own `context` above is the unrelated context-breakdown overlay, and the
  // web dock already addresses the caller's conversations directly through its history rail. It was
  // published to `web` with no dispatch behind it, which showed a menu entry that only ever toasted its
  // own name; keeping it off `web` is also what keeps this name resolving once per surface.
  { name: 'context', description: 'Continue this channel in one of your conversations', kind: 'picker', surfaces: ['discord', 'whatsapp', 'telegram', 'msteams'] },
  { name: 'fast', description: 'Toggle OpenAI OAuth priority processing', kind: 'action', surfaces: ['cli', 'discord', 'whatsapp', 'telegram', 'msteams', 'web'] },
  // Every surface wires its own picker: the CLI TUI's overlay, a native /reasoning command on Discord,
  // WhatsApp, Telegram and Teams, and the web dock's ReasoningModal (which also carries the "show"
  // sub-behaviour as a Thought-rows switch).
  { name: 'reasoning', description: 'Set the reasoning effort · "show" toggles Thought rows', kind: 'picker' },
  { name: 'theme', description: 'Switch the terminal colour theme', kind: 'picker', surfaces: ['cli'] },
  // CLI-local like /theme: toggles the flame mascot and persists the choice in cli-prefs.json. Purely
  // local chrome, so it is never mirrored to the server — meaningless on the other surfaces.
  { name: 'maskot', description: 'Show or hide the flame mascot (on by default)', kind: 'action', surfaces: ['cli'] },
  // CLI-local: opens the keybinds modal in the TUI (parseCommand dispatches it before any server call).
  // Lives in the catalog so the CLI command menu lists it from the single roster, not a synthetic inject.
  { name: 'keybinds', description: 'List keyboard shortcuts and where to customize them', kind: 'info', surfaces: ['cli'] },
  // CLI-only: ticks what the bottom status bar shows. The toggles are the statusline plugin's shared
  // config (also editable in the web dock), so the picker PATCHes it server-side and refreshes the bar.
  { name: 'statusline', description: 'Choose what the bottom status bar shows', kind: 'picker', surfaces: ['cli'], requiresPlugin: 'statusline' },
  // CLI-local like /theme: `process.chdir` in the TUI's own process. Every request already reports the
  // client's cwd per turn, so moving the process is the whole mechanism. Meaningless on the other
  // surfaces — they have no local directory to move.
  { name: 'cd', description: 'Change the working directory (no argument reports it)', kind: 'action', surfaces: ['cli'] },
  // CLI-local like /theme: reads THIS machine's clipboard (xclip/wl-paste/pngpaste) and parks the
  // image as a pending attachment for the next message — never server-dispatched.
  { name: 'paste', description: 'Attach an image from the system clipboard', kind: 'action', surfaces: ['cli'] },
  // CLI-local like /theme: the TUI suspends itself and round-trips the draft through $VISUAL/$EDITOR.
  { name: 'editor', description: 'Compose the prompt in your $EDITOR', kind: 'picker', surfaces: ['cli'] },
  // CLI-local: downloads the conversation to the launch directory (HTML transcript or JSONL). The web
  // dock has its own download buttons in the Sessions panel, so this stays CLI-only.
  { name: 'export', description: 'Download this conversation ("html" or "jsonl")', kind: 'action', surfaces: ['cli'] },
  // A `picker` (like `/statusline`): the CLI opens its own modal and drives the lsp plugin's REST
  // surface — `/brain/lsp` for the status rows, the plugin's config slice for the on/off flip — so it is
  // never server-dispatched through POST /brain/command. Core carries the NAME only, because a plugin
  // can contribute a prompt macro but not a native modal command; with the plugin disabled the modal
  // reports exactly that (GET /brain/lsp answers 503). adminOnly: the toggle stops/starts language
  // servers for everyone, so it stays operator-gated.
  { name: 'lsp', description: 'Language diagnostics (LSP) — status, servers and on/off', kind: 'picker', surfaces: ['cli'], adminOnly: true, requiresPlugin: 'lsp' },
  { name: 'restart', description: 'Restart the Elowen daemon', kind: 'action', adminOnly: true },
  { name: 'help', description: 'Show the available commands', kind: 'info' },
  // CLI-only conversation management (the other surfaces manage conversations through their own UI).
  { name: 'sessions', description: 'Pick a conversation', kind: 'picker', surfaces: ['cli'] },
  { name: 'resume', description: 'Resume a conversation', kind: 'picker', surfaces: ['cli'] },
  // Also on the web dock: it renders its own rename dialog and PATCHes /brain/sessions/:id (the same
  // metadata endpoint the history rail's rename uses).
  { name: 'rename', description: 'Rename this conversation', kind: 'picker', surfaces: ['cli', 'web'] },
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

/** Look up one command by name (any surface). `context` is deliberately carried twice — the CLI's context
 *  breakdown and the platforms' channel re-key — so this returns the FIRST match and is only safe for
 *  surface-independent questions. Anything that renders or dispatches per surface must use
 *  {@link commandsFor}, where each name resolves once. */
export function findCommand(name: string): SlashCommandDef | undefined {
  return SLASH_COMMANDS.find((c) => c.name === name);
}

/** True when `name` is a built-in command — used to refuse a plugin command that would shadow one. */
export function isBuiltinCommand(name: string): boolean {
  return SLASH_COMMANDS.some((c) => c.name === name);
}

/** Command names the chat adapters own locally — NOT daemon commands (so absent from SLASH_COMMANDS), but
 *  still reserved: a plugin command sharing one collides with the adapter's own slash on that surface. On
 *  Discord both would land in one bulk registration payload → a 400 that drops EVERY slash command for the
 *  guild; across surfaces the shadow resolves inconsistently (Discord runs the macro, Telegram the built-in).
 *  Kept beside the built-ins so there is ONE reserved-name check. Must track the adapter-local commands. */
const RESERVED_ADAPTER_COMMANDS = new Set(['voice', 'display']);

/** True when `name` is a built-in OR an adapter-local reserved command — the single guard a plugin command
 *  must clear so it can never shadow/collide with either on any surface. */
export function isReservedCommandName(name: string): boolean {
  return isBuiltinCommand(name) || RESERVED_ADAPTER_COMMANDS.has(name);
}

/** A plugin-contributed prompt command as a SlashCommandDef, for merging into a surface's menu. */
export interface PluginSlashCommand { name: string; description: string; prompt: string; surfaces?: SlashSurface[]; plugin?: string }
function pluginCommandDef(cmd: PluginSlashCommand): SlashCommandDef {
  return { name: cmd.name, description: cmd.description, kind: 'prompt', prompt: cmd.prompt, surfaces: cmd.surfaces, plugin: cmd.plugin };
}

/** The full menu for a surface/user: built-ins first, then plugin prompt commands (surface-scoped,
 *  built-in names never shadowed). Single source both `/brain/commands` and any test builds from.
 *
 *  `loadedPlugins` is the set of plugins actually running, and it is REQUIRED rather than optional so a
 *  future caller cannot silently opt out of the gate and republish a command for a plugin that is not
 *  there. Pass the live registry's set; an empty set correctly hides every plugin-gated built-in. */
export function commandsWithPlugins(
  surface: SlashSurface,
  isAdmin: boolean,
  pluginCommands: PluginSlashCommand[],
  loadedPlugins: ReadonlySet<string>,
): SlashCommandDef[] {
  const base = commandsFor(surface, isAdmin).filter((c) => !c.requiresPlugin || loadedPlugins.has(c.requiresPlugin));
  const extra = pluginCommands
    .filter((c) => (!c.surfaces || c.surfaces.includes(surface)) && !isReservedCommandName(c.name))
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
