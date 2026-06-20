/**
 * Single source of truth for executor (exec) metadata.
 *
 * An "exec" is a model spec carried in a task's `exec:<spec>` label or in config fields
 * (defaults.exec, autopilot.pilotExec/overseerExec). It resolves to an agent *program*
 * (the CLI that runs the model). Previously this knowledge was duplicated between
 * `overseer/routing.ts` (PROGRAM_PREFIXES) and `store/configStore.ts` (KNOWN_EXECS); both
 * now import from here so adding/changing an executor is a one-line edit. See audit #43/S21/O22.
 */

/** Agent program ids understood by spawn() / resolveExecutor. */
export type Program = 'claude-code' | 'opencode' | 'codex';

/** Explicit `<prefix>:<model>` spec prefixes, in match order, mapped to their program. */
export const PROGRAM_PREFIXES: Readonly<Record<string, Program>> = {
  'codex:': 'codex',
  'opencode:': 'opencode',
  'claude:': 'claude-code',
};

/** Program a bare (prefix-less) spec routes to depending on whether it looks like `provider/model`. */
export const BARE_WITH_SLASH_PROGRAM: Program = 'opencode';
export const BARE_PLAIN_PROGRAM: Program = 'claude-code';

/**
 * Default executable name per program. Keyed by Program id so it stays in sync with the prefixes
 * above. Consumed as the provider allow-list seed in configStore.
 */
export const DEFAULT_BINS: Readonly<Record<Program, string>> = {
  'claude-code': 'claude',
  'opencode': 'opencode',
  'codex': 'codex',
};

/** Built-in exec labels offered/allowed out of the box (the default `allowedExecs`). */
export const KNOWN_EXECS: readonly string[] = [
  'sonnet',
  'deepseek/deepseek-v4-flash',
  'kimi-for-coding/k2p7',
  'ollama/minimax-m2.7:cloud',
  'codex:gpt-5.4',
];

/**
 * Whether a non-empty exec spec is well-formed: it either carries an explicit program prefix
 * (`codex:` / `opencode:` / `claude:`) or has a `provider/model` slash shape. Bare plain strings
 * (e.g. `foo`) are NOT well-formed on their own — resolveExecutor would silently treat them as a
 * claude-code model name. Such specs are only valid when explicitly allow-listed (see isAllowedExec).
 */
export function isWellFormedExec(spec: string): boolean {
  if (Object.keys(PROGRAM_PREFIXES).some(p => spec.startsWith(p))) return true;
  return spec.includes('/');
}

/**
 * Validate an exec for storage in config. An exec is acceptable when it is on the allow-list, or
 * when it is well-formed (so an admin can point pilot/overseer at any prefixed/slash spec). A bare
 * plain string that is not allow-listed is rejected — it would otherwise become a bogus
 * claude-code model. Empty string means "unset" and is always acceptable.
 */
export function isAllowedExec(spec: string, allowedExecs: readonly string[]): boolean {
  if (spec === '') return true;
  if (allowedExecs.includes(spec)) return true;
  return isWellFormedExec(spec);
}
