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

/**
 * Program a bare (prefix-less) spec routes to depending on whether it looks like `provider/model`.
 *
 * `provider/model` means the EMBEDDED BRAIN: it is the identity users see and type, so it is the one
 * that gets to be spelled without ceremony. OpenCode, which held this shape historically, now names
 * itself explicitly with `opencode:` — migration v13 rewrote every stored bare-slash value, and both
 * KNOWN_EXECS and the web presets ship prefixed. Exactly one program may own the unprefixed shape;
 * giving it to the brain is what removes `elowen:` from stored data instead of merely respelling it.
 */
export const BARE_WITH_SLASH_PROGRAM: Program = 'elowen';
export const BARE_PLAIN_PROGRAM: Program = 'claude-code';
/** Internal PI registry namespace for custom brain providers; never part of the public exec identity. */
export const BRAIN_REGISTRY_PROVIDER_PREFIX = 'elowen-';

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
 * Structured executor identity — the single source of truth for "which program runs which model".
 * The embedded brain is the only program whose identity needs a provider: the same model id can be
 * reachable through several configured brain providers, and collapsing them would merge two distinct
 * models. Every other program identifies a model by name alone.
 */
export type ExecRef =
  | { program: 'elowen'; provider: string; model: string }
  | { program: Exclude<Program, 'elowen'>; model: string };

/** The structured form accepted on the wire / in arguments, next to the legacy `<prefix>:<model>`
 *  string. `program` is validated against the Program set; it is never inferred from the value's shape. */
export interface ExecRefInput { program: string; provider?: string; model: string }

/** What the central parser accepts: the legacy string spec, or the structured form. */
export type ExecInput = string | ExecRefInput;

/** Every known program id, derived from DEFAULT_BINS so the set cannot drift from the routing table. */
export const PROGRAMS: readonly Program[] = Object.keys(DEFAULT_BINS) as Program[];

export function isProgram(value: unknown): value is Program {
  return typeof value === 'string' && (PROGRAMS as readonly string[]).includes(value);
}

/**
 * The program a LEGACY exec string names.
 *
 * An explicit `<prefix>:` from PROGRAM_PREFIXES decides on its own. Only a prefix-LESS value falls
 * back to the shape contract — and that contract predates the brain and belongs to the CLI agents:
 * `provider/model` is OpenCode, a bare name is Claude Code. A slash therefore NEVER means `elowen`.
 * Reading a bare `provider/model` as the embedded brain would silently re-route every OpenCode exec
 * already stored in configs and task labels, which is exactly the breakage this migration avoids.
 */
export function execSpecProgram(spec: string): Program {
  const encoded = parseEncodedExecRef(spec);
  if (encoded) return encoded.program;
  for (const [prefix, program] of Object.entries(PROGRAM_PREFIXES)) {
    if (spec.startsWith(prefix)) return program;
  }
  return spec.includes('/') ? BARE_WITH_SLASH_PROGRAM : BARE_PLAIN_PROGRAM;
}

function parseEncodedExecRef(input: string): ExecRef | null {
  if (!input.startsWith('elowen|')) return null;
  const parts = input.split('|');
  if (parts.length !== 3) return null;
  try {
    const provider = decodeURIComponent(parts[1] ?? '');
    const model = decodeURIComponent(parts[2] ?? '');
    return provider && model ? { program: 'elowen', provider, model } : null;
  } catch { return null; }
}

/**
 * THE parser: legacy string or structured input → structured identity. Returns null when the value
 * cannot name a runnable model (empty model, or an `elowen:` spec carrying no provider).
 *
 * The program comes from the explicit prefix (string form) or the explicit `program` field
 * (structured form) — never from a heuristic over the value's shape. While the dual-read window is
 * open both forms must resolve to the same program for the same model, so a value written by an old
 * release keeps routing where it always did.
 */
export function parseExecRef(input: ExecInput): ExecRef | null {
  if (typeof input !== 'string') {
    if (!isProgram(input.program) || !input.model) return null;
    if (input.program === 'elowen') {
      return input.provider ? { program: 'elowen', provider: input.provider, model: input.model } : null;
    }
    return { program: input.program, model: input.model };
  }
  const encoded = parseEncodedExecRef(input);
  if (encoded) return encoded;
  const program = execSpecProgram(input);
  if (program === 'elowen') {
    const parsed = parseElowenExec(input);
    return parsed ? { program: 'elowen', ...parsed } : null;
  }
  const prefix = Object.keys(PROGRAM_PREFIXES).find((p) => input.startsWith(p));
  const model = prefix ? input.slice(prefix.length) : input;
  return model ? { program, model } : null;
}

/**
 * Structured identity → the canonical persisted spec. The embedded brain writes `<provider>/<model>`
 * with NO prefix — that is the whole point of this migration, so `elowen:` and the interim
 * `elowen|…` composite are read-only legacy. Claude Code keeps its bare model name; every other
 * program names itself with its explicit prefix, OpenCode included.
 */
export function execRefSpec(ref: ExecRef): string {
  if (ref.program === 'elowen') return `${ref.provider}/${ref.model}`;
  const prefix = Object.entries(PROGRAM_PREFIXES).find(([, p]) => p === ref.program)?.[0] ?? '';
  // claude-code keeps its historical bare form: prefixing `sonnet` would change nothing but would
  // churn every stored value. A plain name already routes back to claude-code on its own.
  if (ref.program === BARE_PLAIN_PROGRAM && !ref.model.includes('/')) return ref.model;
  return `${prefix}${ref.model}`;
}

/**
 * Whether a value names the embedded brain — asked by every permission/readiness/UI branch that used
 * to test `startsWith('elowen:')`. Decided by the program, never by the text: the structured form
 * answers from its `program` field, and the legacy string from its explicit prefix (so a malformed
 * `elowen:<model>` with no provider still counts as a brain value, exactly as the prefix test did).
 */
export function isElowenExec(input: ExecInput): boolean {
  return typeof input === 'string' ? execSpecProgram(input) === 'elowen' : input.program === 'elowen';
}

/**
 * Brain-model exec spec, canonically `<provider>/<model>` and historically `elowen:<provider>/<model>`
 * (plus the short-lived `elowen|provider|model` composite, read-only). The provider id never contains
 * a slash, so we split on the FIRST one — the model part may carry more (e.g. `relay/ollama/kimi-k2.7-code`).
 * Returns null for anything that isn't a well-formed brain exec.
 */
export function parseElowenExec(spec: string): { provider: string; model: string } | null {
  const encoded = parseEncodedExecRef(spec);
  if (encoded?.program === 'elowen') return { provider: encoded.provider, model: encoded.model };
  const rest = spec.startsWith('elowen:') ? spec.slice('elowen:'.length) : spec;
  // Only the canonical bare shape is accepted here besides the legacy prefix; a value carrying some
  // OTHER program's prefix must never be read as a brain exec just because it contains a slash.
  if (rest === spec && Object.keys(PROGRAM_PREFIXES).some(p => spec.startsWith(p))) return null;
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { provider: rest.slice(0, slash), model: rest.slice(slash + 1) };
}

/** Compose the exec spec for a brain model — a thin alias over the structured formatter. */
export function elowenExec(provider: string, model: string): string {
  return execRefSpec({ program: 'elowen', provider, model });
}

/** The stored/comparable spec for either input form — null when the structured form names nothing
 *  runnable. Allow-lists persist strings, so a structured value is judged by the spec it denotes. */
function execSpecOf(input: ExecInput): string | null {
  const ref = parseExecRef(input);
  if (!ref) return null;
  if (ref.program === 'elowen') return execRefSpec(ref);
  return typeof input === 'string' ? input : execRefSpec(ref);
}

function includesExec(list: readonly string[], spec: string): boolean {
  return list.some(value => execSpecOf(value) === spec);
}

/**
 * Per-user exec permission, shared by the API routes and the brain: admins may use anything;
 * everyone else is bounded by the global allow-list AND their personal whitelist (an empty
 * personal list means "everything the global list allows"). `user` null/undefined = open mode.
 * Accepts either identity form; a structured value that names no runnable model is refused.
 */
export function isExecAllowedForUser(
  user: { is_admin: boolean; allowed_execs: readonly string[] } | null | undefined,
  globalExecs: readonly string[],
  exec: ExecInput,
  brainProviders: readonly string[],
): boolean {
  if (!user || user.is_admin) return true;
  const spec = execSpecOf(exec);
  if (spec === null) return false;
  // Brain execs are bounded by the configured brain PROVIDERS (the model list is built only from them),
  // NOT by `KNOWN_EXECS`/allowedExecs, which cover CLI-agent specs only. So a brain exec skips the global
  // bound — else non-admins get an empty brain-model picker. Only the per-user allow-list still narrows
  // it. CLI execs keep the global bound.
  if (!isConfiguredBrainExec(exec, brainProviders) && !includesExec(globalExecs, spec)) return false;
  return user.allowed_execs.length === 0 || includesExec(user.allowed_execs, spec);
}

/**
 * Whether a value names a brain model on a provider this installation actually has configured.
 *
 * This is the test that may skip the global allow-list, and it is deliberately narrower than
 * `isElowenExec`. Since the canonical brain spelling is bare `<provider>/<model>`, ANY slash-shaped
 * string now parses as a brain exec — so asking only "is this the brain?" would let `bogus/model`
 * through the bound that exists to stop exactly that. Membership in the configured provider set is
 * what separates a real model from a well-shaped string.
 */
export function isConfiguredBrainExec(input: ExecInput, brainProviders: readonly string[]): boolean {
  const ref = parseExecRef(input);
  return ref?.program === 'elowen' && brainProviders.includes(ref.provider);
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
  exec: ExecInput,
  brainProviders: readonly string[],
): boolean {
  const spec = execSpecOf(exec);
  if (spec === null) return false;
  // Brain execs are bounded by configured providers, not KNOWN_EXECS — see isExecAllowedForUser.
  if (!isConfiguredBrainExec(exec, brainProviders) && !includesExec(globalExecs, spec)) return false;
  if (!user) return true;
  return user.allowed_execs.length === 0 || includesExec(user.allowed_execs, spec);
}

/** Built-in exec labels offered/allowed out of the box (the default `allowedExecs`). Keep in sync
 *  with the web preset list (`web/lib/execPresets.ts`) and the default notes below. */
export const KNOWN_EXECS: readonly string[] = [
  'opencode:ollama-cloud/glm-5.2',
  'codex:gpt-5.5',
  'sonnet',
  'opus',
  'opencode:ollama-cloud/deepseek-v4-pro',
  'opencode:ollama/kimi-k2.7-code',
  'opencode:ollama-cloud/minimax-m3',
  'opencode:ollama-cloud/deepseek-v4-flash',
  'opencode:ollama-cloud/minimax-m2.7',
  'opencode:ollama-cloud/glm-5.1',
  'opencode:ollama-cloud/qwen3.5',
];

/**
 * Default capability notes for the built-in models, keyed by exec. Seeded into config so a fresh
 * install ships with sensible descriptions, and merged *under* stored notes (user edits win) so the
 * autopilot model picker has something to reason about out of the box. Keep keys aligned with
 * KNOWN_EXECS. Notes are English — they are fed verbatim into the (English) planner prompt.
 */
export const EXEC_NOTES: Readonly<Record<string, string>> = {
  'opencode:ollama-cloud/glm-5.2': 'Open frontier model, near Claude Opus on agentic coding; sustains long autonomous tool-use sessions. Strong all-rounder for complex, multi-step work.',
  'codex:gpt-5.5': "OpenAI's strongest agentic coder (via Codex) — excellent long-horizon planning, debugging, and end-to-end PR work.",
  'sonnet': 'Claude Sonnet — fast, reliable everyday coder with strong tool use and instruction following. A solid default for most tasks.',
  'opus': 'Claude Opus — most capable reasoner; best for hard architecture, large multi-file refactors, and tricky debugging.',
  'opencode:ollama-cloud/deepseek-v4-pro': 'Top open-source raw coding; best for whole-codebase refactors and hard SWE-bench-style problems.',
  'opencode:ollama/kimi-k2.7-code': 'Agentic coding specialist — long-horizon tasks with heavy multi-tool and sub-agent orchestration.',
  'opencode:ollama-cloud/minimax-m3': 'Efficient agentic coder — multi-file edits and code-run-fix loops at low cost and high throughput.',
  'opencode:ollama-cloud/deepseek-v4-flash': 'Faster, cheaper DeepSeek V4 — strong coding at low latency, good for quick iterations.',
  'opencode:ollama-cloud/minimax-m2.7': 'Cheap, fast agentic model — routine multi-file edits and test-validated fixes.',
  'opencode:ollama-cloud/glm-5.1': 'Open agentic model for long-running tasks (hours of tool calls); a step below GLM 5.2.',
  'opencode:ollama-cloud/qwen3.5': 'Best-in-class instruction following and function-calling; balanced reasoning and coding agent.',
};

/**
 * Whether a non-empty exec spec is well-formed: it either carries an explicit program prefix
 * (`codex:` / `opencode:` / `claude:`) or has a `provider/model` slash shape. Bare plain strings
 * (e.g. `foo`) are NOT well-formed on their own — resolveExecutor would silently treat them as a
 * claude-code model name. Such specs are only valid when explicitly allow-listed (see isAllowedExec).
 */
export function isWellFormedExec(spec: string): boolean {
  if (parseEncodedExecRef(spec)) return true;
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
