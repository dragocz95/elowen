import type { SlashCommandDef } from './types';

export interface SlashInvocation {
  command: SlashCommandDef;
  argument?: string;
}

/** Resolve a complete slash invocation against the daemon-published catalog.
 * Unknown names and slash-prefixed prose remain ordinary chat text. */
export function parseSlashInvocation(text: string, commands: readonly SlashCommandDef[]): SlashInvocation | null {
  const match = /^\/(\w+)(?:\s+(.+))?$/.exec(text.trim());
  if (!match) return null;
  const command = commands.find((candidate) => candidate.name === match[1]);
  if (!command) return null;
  return { command, ...(match[2] ? { argument: match[2] } : {}) };
}
