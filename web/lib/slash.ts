import type { SlashCommandDef } from './types';

/** Expand a plugin prompt-command template with the user's typed arguments — behavioural mirror of the
 *  daemon's `expandPromptCommand` (src/brain/slashCommands.ts): `$ARGS` → the whole arg string, `$1..$9`
 *  → positionals (missing → ''), substituted literally in one pass so `$`-sequences in the args are never
 *  re-interpreted; a template with no placeholders gets the args appended as a trailing paragraph. */
export function expandPromptCommand(prompt: string, args: string): string {
  const trimmed = args.trim();
  const positionals = trimmed ? trimmed.split(/\s+/) : [];
  const usesPlaceholders = /\$ARGS\b|\$[1-9]\b/.test(prompt);
  let out = prompt.replace(/\$ARGS\b|\$([1-9])\b/g, (_, d: string | undefined) =>
    d ? (positionals[Number(d) - 1] ?? '') : trimmed);
  if (!usesPlaceholders && trimmed) out = `${out}\n\n${trimmed}`;
  return out.trim();
}

/** If `text` invokes a plugin prompt command (`/name [args…]`), return the expanded prompt to send to the
 *  agent; null when it isn't one (built-ins and plain text pass through the caller's normal path). */
export function expandSlashMessage(text: string, commands: SlashCommandDef[]): string | null {
  const m = /^\/(\S+)(?:\s+([\s\S]+))?$/.exec(text.trim());
  if (!m) return null;
  const def = commands.find((c) => c.name === m[1] && c.kind === 'prompt' && c.prompt);
  return def ? expandPromptCommand(def.prompt ?? '', m[2] ?? '') : null;
}
