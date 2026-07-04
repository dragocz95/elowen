/** THE single source of truth for chat slash commands, shared by every surface (CLI TUI, Discord,
 *  web dock). Each surface renders its command menu from this list and routes execution by `kind`;
 *  the daemon publishes the (identity-filtered) list at `GET /brain/commands` and executes the
 *  server-side ones at `POST /brain/command`. Add a new command HERE only — never per surface. */

export type SlashSurface = 'cli' | 'discord' | 'web';

/** How a surface handles the command once the user picks it:
 *  - `action`: a server-side effect with no chooser (new, stop, compact, restart) — POST /brain/command.
 *  - `info`:   fetch + render data (status, help) — no state change.
 *  - `picker`: opens a surface-local chooser (model, think, and the CLI conversation pickers). */
export type SlashKind = 'action' | 'info' | 'picker';

export interface SlashCommandDef {
  name: string;
  /** One-line help shown in every surface's menu. English (surfaces localize their own chrome only). */
  description: string;
  kind: SlashKind;
  /** Gated to the instance operator (owner). e.g. `restart`. */
  adminOnly?: boolean;
  /** Which surfaces expose it. Omitted → all three. The CLI conversation pickers are CLI-only. */
  surfaces?: SlashSurface[];
}

/** The canonical command set. Order is the display order in menus. */
export const SLASH_COMMANDS: readonly SlashCommandDef[] = [
  { name: 'new', description: 'Start a fresh conversation', kind: 'action' },
  { name: 'stop', description: 'Stop the running agent', kind: 'action' },
  { name: 'status', description: 'Session info — model, context and usage', kind: 'info' },
  { name: 'compact', description: 'Summarize the conversation to free up context', kind: 'action' },
  { name: 'model', description: 'Switch the AI model', kind: 'picker' },
  { name: 'think', description: 'Set the reasoning effort', kind: 'picker' },
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

/** The server-dispatchable commands (`action`/`info`) — the ones `POST /brain/command` can run. Pickers
 *  are surface-local UI and never dispatch here. */
export const DISPATCHABLE = new Set<string>(
  SLASH_COMMANDS.filter((c) => c.kind === 'action' || c.kind === 'info').map((c) => c.name),
);
