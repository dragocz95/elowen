/**
 * Single source of truth for executor (exec) metadata.
 *
 * An "exec" is a model spec carried in a task's `exec:<spec>` label or in config fields
 * (defaults.exec, autopilot.pilotExec/overseerExec). It resolves to an agent *program*
 * (the CLI that runs the model). Previously this knowledge was duplicated between
 * `overseer/routing.ts` (PROGRAM_PREFIXES) and `store/configStore.ts` (KNOWN_EXECS); both
 * now import from here so adding/changing an executor is a one-line edit. See audit #43/S21/O22.
 */

/** Agent program ids understood by spawn() / resolveExecutor. `elowen` is the embedded brain —
 *  it runs in-process on an Elowen AI provider instead of spawning an external CLI. */
export type Program = 'claude-code' | 'opencode' | 'codex' | 'kilo' | 'pi' | 'omp' | 'elowen';

/** Explicit `<prefix>:<model>` spec prefixes, in match order, mapped to their program. */
export const PROGRAM_PREFIXES: Readonly<Record<string, Program>> = {
  'codex:': 'codex',
  'opencode:': 'opencode',
  'claude:': 'claude-code',
  'kilo:': 'kilo',
  'pi:': 'pi',
  'omp:': 'omp',
  'elowen:': 'elowen',
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
  'kilo': 'kilo',
  'pi': 'pi',
  'omp': 'omp',
  'elowen': '', // embedded brain — no binary is spawned
};

/**
 * Brain-model exec spec: `elowen:<provider>/<model>`. The provider id never contains a slash, so we
 * split on the FIRST one — the model part may carry more (e.g. `elowen:relay/ollama/kimi-k2.7-code`).
 * Returns null for anything that isn't a well-formed elowen exec.
 */
export function parseElowenExec(spec: string): { provider: string; model: string } | null {
  if (!spec.startsWith('elowen:')) return null;
  const rest = spec.slice('elowen:'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { provider: rest.slice(0, slash), model: rest.slice(slash + 1) };
}

/** Compose the exec spec for a brain model (the single place the format is produced). */
export function elowenExec(provider: string, model: string): string {
  return `elowen:${provider}/${model}`;
}

/**
 * Per-user exec permission, shared by the API routes and the brain: admins may use anything;
 * everyone else is bounded by the global allow-list AND their personal whitelist (an empty
 * personal list means "everything the global list allows"). `user` null/undefined = open mode.
 */
export function isExecAllowedForUser(
  user: { is_admin: boolean; allowed_execs: readonly string[] } | null | undefined,
  globalExecs: readonly string[],
  exec: string,
): boolean {
  if (!user || user.is_admin) return true;
  // `elowen:<provider>/<model>` brain execs are bounded by the configured brain PROVIDERS (the model list
  // is built only from them), NOT by `KNOWN_EXECS`/allowedExecs, which cover CLI-agent specs only. So a
  // brain exec skips the global bound — else non-admins get an empty brain-model picker. Only the
  // per-user allow-list still narrows it. CLI execs keep the global bound.
  if (!exec.startsWith('elowen:') && !globalExecs.includes(exec)) return false;
  return user.allowed_execs.length === 0 || user.allowed_execs.includes(exec);
}

/**
 * Which execs a user's PICKER should OFFER — a display filter, not a permission gate. Unlike
 * `isExecAllowedForUser`, an admin's own non-empty personal whitelist still narrows their picker: a
 * curated shortlist is a preference, not a restriction, so it applies even though the admin *could*
 * run anything. Empty personal list = everything the global list allows. `user` null = open mode.
 */
export function isModelVisibleForUser(
  user: { allowed_execs: readonly string[] } | null | undefined,
  globalExecs: readonly string[],
  exec: string,
): boolean {
  // Brain execs (elowen:…) are bounded by configured providers, not KNOWN_EXECS — see isExecAllowedForUser.
  if (!exec.startsWith('elowen:') && !globalExecs.includes(exec)) return false;
  if (!user) return true;
  return user.allowed_execs.length === 0 || user.allowed_execs.includes(exec);
}

/** Built-in exec labels offered/allowed out of the box (the default `allowedExecs`). Keep in sync
 *  with the web preset list (`web/lib/execPresets.ts`) and the default notes below. */
export const KNOWN_EXECS: readonly string[] = [
  'ollama-cloud/glm-5.2',
  'codex:gpt-5.5',
  'sonnet',
  'opus',
  'ollama-cloud/deepseek-v4-pro',
  'ollama/kimi-k2.7-code',
  'ollama-cloud/minimax-m3',
  'ollama-cloud/deepseek-v4-flash',
  'ollama-cloud/minimax-m2.7',
  'ollama-cloud/glm-5.1',
  'ollama-cloud/qwen3.5',
];

/**
 * Default capability notes for the built-in models, keyed by exec. Seeded into config so a fresh
 * install ships with sensible descriptions, and merged *under* stored notes (user edits win) so the
 * autopilot model picker has something to reason about out of the box. Keep keys aligned with
 * KNOWN_EXECS. Notes are English — they are fed verbatim into the (English) planner prompt.
 */
export const EXEC_NOTES: Readonly<Record<string, string>> = {
  'ollama-cloud/glm-5.2': 'Open frontier model, near Claude Opus on agentic coding; sustains long autonomous tool-use sessions. Strong all-rounder for complex, multi-step work.',
  'codex:gpt-5.5': "OpenAI's strongest agentic coder (via Codex) — excellent long-horizon planning, debugging, and end-to-end PR work.",
  'sonnet': 'Claude Sonnet — fast, reliable everyday coder with strong tool use and instruction following. A solid default for most tasks.',
  'opus': 'Claude Opus — most capable reasoner; best for hard architecture, large multi-file refactors, and tricky debugging.',
  'ollama-cloud/deepseek-v4-pro': 'Top open-source raw coding; best for whole-codebase refactors and hard SWE-bench-style problems.',
  'ollama/kimi-k2.7-code': 'Agentic coding specialist — long-horizon tasks with heavy multi-tool and sub-agent orchestration.',
  'ollama-cloud/minimax-m3': 'Efficient agentic coder — multi-file edits and code-run-fix loops at low cost and high throughput.',
  'ollama-cloud/deepseek-v4-flash': 'Faster, cheaper DeepSeek V4 — strong coding at low latency, good for quick iterations.',
  'ollama-cloud/minimax-m2.7': 'Cheap, fast agentic model — routine multi-file edits and test-validated fixes.',
  'ollama-cloud/glm-5.1': 'Open agentic model for long-running tasks (hours of tool calls); a step below GLM 5.2.',
  'ollama-cloud/qwen3.5': 'Best-in-class instruction following and function-calling; balanced reasoning and coding agent.',
};

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
