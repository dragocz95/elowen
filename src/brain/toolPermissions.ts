import type { AskAnswer, AskQuestion } from './events.js';

/** Granular tool permissions (opencode-style): every tool call resolves to one of three actions.
 *  `allow` runs, `deny` returns an error result to the model, `ask` blocks on a human approval prompt
 *  where one is attached (owner CLI/web chat). Everywhere else (channel/cron/subagent turns — no
 *  approval channel) `ask` follows the user's `unattendedAsks` setting: 'allow' (default) runs, 'deny'
 *  (strict mode) refuses; `deny` rules always deny (see the execute-time gate in
 *  session/capabilities.ts). */
export type PermissionAction = 'allow' | 'ask' | 'deny';

/** Two independent pattern spaces: `tools` matches TOOL NAMES; `bash` matches the COMMAND STRING of
 *  shell tools (see {@link BASH_PERMISSION_TOOLS}) — so "git *" can be allowed while "rm *" is denied
 *  even though both run through the same Bash tool. */
export type PermissionScope = 'tools' | 'bash';

export interface PermissionRule { scope: PermissionScope; pattern: string; action: PermissionAction }

/**
 * The durable part of a permission context which is safe to hand to an unattended delegated run.
 * It deliberately stores the already-effective ordered rules rather than a user id: a sub-agent can
 * be resumed after eviction without re-reading a different account's current settings. `yolo`, approval
 * callbacks and "always allow" persistence are intentionally absent — a delegated channel has no
 * interactive approval surface.
 */
export interface NoninteractivePermissionBoundary {
  rules: PermissionRule[];
  unattendedAsks: 'allow' | 'deny';
}

/** The per-user persisted shape (userSettingStore JSON blob under key `permissions`): rule maps keep
 *  their JSON insertion order (it is load-bearing — see {@link resolveToolPermission}), plus the
 *  persisted YOLO default a session's `/yolo` override layers on top of. */
export interface PermissionSettings {
  tools: Record<string, PermissionAction>;
  bash: Record<string, PermissionAction>;
  /** Default YOLO state for new sessions: `ask` resolves to `allow` without prompting (deny still
   *  denies). The CLI `/yolo` command overrides it per session without touching this value. */
  yolo: boolean;
  /** What an `ask` rule does on an UNATTENDED turn (channel/cron/subagent — no human parked on an
   *  approval prompt): 'allow' (default) resolves it to allow, 'deny' (strict mode) refuses the call
   *  outright. A hard safety opt-in — even YOLO never overrides the strict denial. */
  unattendedAsks: 'allow' | 'deny';
}

/** Tool names whose permission is decided in the `bash` pattern space, against `args.command`. */
export const BASH_PERMISSION_TOOLS: ReadonlySet<string> = new Set(['Bash']);

/** The read-only shell allow-list: commands that only ever inspect, never mutate. It is the single
 *  source of truth for "safe to run without asking" — consumed both by the built-in defaults below and by
 *  the read-only agent boundary (see brain/agents/readOnlyBoundary.ts), so the two can never drift. */
export const READ_ONLY_BASH_ALLOW: readonly string[] = [
  'git status*', 'git diff*', 'git log*', 'ls', 'ls *', 'pwd', 'cat *', 'grep *', 'which *',
];

/** Built-in defaults, conservative but usable: everything not otherwise named is allowed (read-only
 *  tools stay frictionless), file edits ask, and shell commands ask except for a small read-only
 *  allow-list. User rules are appended AFTER these, so any of them can be overridden per user. */
const DEFAULT_PERMISSION_RULES: readonly PermissionRule[] = [
  { scope: 'tools', pattern: '*', action: 'allow' },
  { scope: 'tools', pattern: 'Write', action: 'ask' },
  { scope: 'tools', pattern: 'Edit', action: 'ask' },
  { scope: 'bash', pattern: '*', action: 'ask' },
  ...READ_ONLY_BASH_ALLOW.map((pattern) => ({ scope: 'bash' as const, pattern, action: 'allow' as const })),
];

const ACTIONS: readonly PermissionAction[] = ['allow', 'ask', 'deny'];
const isAction = (v: unknown): v is PermissionAction => ACTIONS.includes(v as PermissionAction);
const isPermissionScope = (v: unknown): v is PermissionScope => v === 'tools' || v === 'bash';
/** 13 built-ins + at most 200 user rules in each map today; leave bounded headroom for future defaults. */
const MAX_BOUNDARY_RULES = 512;
const MAX_BOUNDARY_PATTERN_CHARS = 200;

/** Keep a user's rule maps bounded and well-typed. Invalid keys/actions are dropped (the blob is
 *  untrusted JSON); insertion order of the surviving entries is preserved — it decides precedence. */
function sanitizeRuleMap(input: unknown): Record<string, PermissionAction> {
  const src = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const out: Record<string, PermissionAction> = {};
  let count = 0;
  for (const [pattern, action] of Object.entries(src)) {
    if (count >= 200) break; // a runaway blob must not balloon per-call rule matching
    if (!pattern.trim() || pattern.length > 200 || !isAction(action)) continue;
    out[pattern] = action;
    count++;
  }
  return out;
}

/** Coerce an untrusted value (parsed JSON blob or request body) into complete, valid settings.
 *  Never throws; missing/invalid fields fall back to empty rules + YOLO off + unattended asks allowed
 *  (the historical behaviour — strict mode is an explicit opt-in). */
export function sanitizePermissionSettings(input: unknown): PermissionSettings {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  return {
    tools: sanitizeRuleMap(src.tools),
    bash: sanitizeRuleMap(src.bash),
    yolo: typeof src.yolo === 'boolean' ? src.yolo : false,
    unattendedAsks: src.unattendedAsks === 'deny' ? 'deny' : 'allow',
  };
}

/** Merge an untrusted partial patch onto the current settings. Each rule map is replaced WHOLESALE when
 *  present in the patch (order inside a map is meaningful, so a key-by-key merge would scramble user
 *  intent); absent fields keep their current value. */
export function mergePermissionSettings(current: PermissionSettings, patch: unknown): PermissionSettings {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
  return sanitizePermissionSettings({
    tools: p.tools !== undefined ? p.tools : current.tools,
    bash: p.bash !== undefined ? p.bash : current.bash,
    yolo: p.yolo !== undefined ? p.yolo : current.yolo,
    unattendedAsks: p.unattendedAsks !== undefined ? p.unattendedAsks : current.unattendedAsks,
  });
}

/** Flatten a user's settings into the effective ordered ruleset: built-in defaults FIRST, then the
 *  user's rules — with last-match-wins resolution the user always overrides the defaults. */
export function buildPermissionRuleset(user: PermissionSettings): PermissionRule[] {
  return [
    ...DEFAULT_PERMISSION_RULES,
    ...Object.entries(user.tools).map(([pattern, action]) => ({ scope: 'tools' as const, pattern, action })),
    ...Object.entries(user.bash).map(([pattern, action]) => ({ scope: 'bash' as const, pattern, action })),
  ];
}

/** Strictly validate an immutable delegated permission boundary. Unlike account-setting sanitization,
 * this never drops malformed entries: changing a stored child from deny to an implicit default would be
 * a privilege escalation, so corrupt/legacy boundaries must fail closed. Rule order is load-bearing. */
export function normalizeNoninteractivePermissionBoundary(raw: unknown): NoninteractivePermissionBoundary | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.rules) || value.rules.length > MAX_BOUNDARY_RULES
    || (value.unattendedAsks !== 'allow' && value.unattendedAsks !== 'deny')) return undefined;
  const rules: PermissionRule[] = [];
  for (const rawRule of value.rules) {
    if (!rawRule || typeof rawRule !== 'object' || Array.isArray(rawRule)) return undefined;
    const rule = rawRule as Record<string, unknown>;
    if (!isPermissionScope(rule.scope) || typeof rule.pattern !== 'string'
      || !rule.pattern.trim() || rule.pattern.length > MAX_BOUNDARY_PATTERN_CHARS || !isAction(rule.action)) return undefined;
    rules.push({ scope: rule.scope, pattern: rule.pattern, action: rule.action });
  }
  return { rules, unattendedAsks: value.unattendedAsks };
}

/** Snapshot the currently effective permission context for a child. A malformed in-memory context is
 * rejected rather than represented as `null` (which means permission wiring was genuinely absent). */
export function noninteractivePermissionBoundary(permissions: TurnPermissions | undefined): NoninteractivePermissionBoundary | null {
  if (!permissions) return null;
  const boundary = normalizeNoninteractivePermissionBoundary({
    rules: permissions.ruleset,
    unattendedAsks: permissions.unattendedAsks,
  });
  if (!boundary) throw new Error('invalid turn permission boundary');
  return boundary;
}

/** Rebuild the noninteractive execution context from its durable child boundary. */
export function noninteractiveTurnPermissions(boundary: NoninteractivePermissionBoundary | null): TurnPermissions | undefined {
  if (boundary === null) return undefined;
  // DelegatedExecutionScope normalized this before persistence/read. Clone anyway so a caller cannot
  // mutate a shared stored scope while the current prompt is in flight.
  return {
    ruleset: boundary.rules.map((rule) => ({ ...rule })),
    yolo: false,
    unattendedAsks: boundary.unattendedAsks,
  };
}

/** Simple wildcard match (opencode semantics): `*` = zero or more of any character, `?` = exactly one,
 *  everything else literal. Anchored at both ends. */
export function matchPermissionPattern(value: string, pattern: string): boolean {
  const rx = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${rx}$`).test(value);
}

/** Leading program wrappers whose real target is their FIRST non-flag argument — so `env rm` / `sudo rm`
 *  gate against `rm`, not the wrapper. Kept deliberately tight: unwrapping an arg-taking wrapper like
 *  `xargs`/`timeout` would mis-identify the program, so they are left in place (their whole segment is
 *  still matched verbatim). */
const BASH_COMMAND_WRAPPERS: ReadonlySet<string> = new Set(['env', 'command', 'sudo', 'nice']);

const basename = (token: string): string => { const s = token.lastIndexOf('/'); return s === -1 ? token : token.slice(s + 1); };

/** The index of the `)` that closes the `(` at `openIdx`, honouring nesting and skipping quoted spans;
 *  -1 if unbalanced (an unterminated `$(…)`). */
function findMatchingParen(input: string, openIdx: number): number {
  let depth = 0, inS = false, inD = false;
  for (let i = openIdx; i < input.length; i++) {
    const ch = input[i]!;
    if (inS) { if (ch === "'") inS = false; continue; }
    if (inD) { if (ch === '\\') { i++; continue; } if (ch === '"') inD = false; continue; }
    if (ch === "'") { inS = true; continue; }
    if (ch === '"') { inD = true; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Consume a double-quoted span starting at the opening `"` (index `openIdx`). Its text stays literal for
 *  operator splitting (a `;`/`&&` inside quotes is NOT a separator), but command substitutions inside it
 *  still fire — their inner command is scanned as its own gated segment. Returns the reconstructed text
 *  (substitutions blanked, since their output is unknowable) and the index just past the closing quote. */
function scanDoubleQuoted(input: string, openIdx: number, segments: string[], state: { ambiguous: boolean }): { text: string; next: number } {
  let text = '"';
  let i = openIdx + 1;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === '\\') { text += input.slice(i, i + 2); i += 2; continue; }
    if (ch === '"') return { text: `${text}"`, next: i + 1 };
    if (ch === '`') {
      const end = input.indexOf('`', i + 1);
      if (end === -1) { state.ambiguous = true; return { text, next: input.length }; }
      scanBashLevel(input.slice(i + 1, end), segments, state); text += ' '; i = end + 1; continue;
    }
    if (ch === '$' && input[i + 1] === '(') {
      const end = findMatchingParen(input, i + 1);
      if (end === -1) { state.ambiguous = true; return { text, next: input.length }; }
      scanBashLevel(input.slice(i + 2, end), segments, state); text += ' '; i = end + 1; continue;
    }
    text += ch; i++;
  }
  state.ambiguous = true; // ran off the end without a closing quote
  return { text, next: input.length };
}

/** Split one command level into simple-command segments (pushed into `segments`), recursing into the
 *  inner command of every substitution. See {@link splitBashSegments}. */
function scanBashLevel(input: string, segments: string[], state: { ambiguous: boolean }): void {
  let current = '';
  const flush = (): void => { const s = current.replace(/\s+/g, ' ').trim(); if (s) segments.push(s); current = ''; };
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === "'") { // single quotes: everything literal until the next single quote
      const end = input.indexOf("'", i + 1);
      if (end === -1) { state.ambiguous = true; current += input.slice(i); break; }
      current += input.slice(i, end + 1); i = end + 1; continue;
    }
    if (ch === '"') { const r = scanDoubleQuoted(input, i, segments, state); current += r.text; i = r.next; continue; }
    if (ch === '`') { // command substitution — gate its inner command on its own
      const end = input.indexOf('`', i + 1);
      if (end === -1) { state.ambiguous = true; break; }
      scanBashLevel(input.slice(i + 1, end), segments, state); current += ' '; i = end + 1; continue;
    }
    if (ch === '$' && input[i + 1] === '(') {
      const end = findMatchingParen(input, i + 1);
      if (end === -1) { state.ambiguous = true; break; }
      scanBashLevel(input.slice(i + 2, end), segments, state); current += ' '; i = end + 1; continue;
    }
    if ((ch === '<' || ch === '>') && input[i + 1] === '(') { // process substitution `<(cmd)` / `>(cmd)`
      // Gate the inner command on its OWN, exactly like `$(…)`: otherwise `cat <(rm -rf ~)` would stay one
      // segment matching a `cat *` allow (no `>` for the redirection deny to catch) and smuggle a mutating
      // command past a read-only boundary. The `(` must follow immediately — a bare `<`/`>` is a redirect.
      const end = findMatchingParen(input, i + 1);
      if (end === -1) { state.ambiguous = true; break; }
      scanBashLevel(input.slice(i + 2, end), segments, state); current += ' '; i = end + 1; continue;
    }
    // Control operators (outside quotes): `;`, newline, `|`/`||`, `&`/`&&` — the two-char forms just
    // produce an empty segment between the flushes, which flush() drops.
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') { flush(); i++; continue; }
    current += ch; i++;
  }
  flush();
}

/** Split a shell command line into its constituent simple-commands so each is gated on its OWN — a
 *  permission rule must never let a chained or substituted command ride an allow/prefix that matched
 *  only the first program (e.g. `cat x && rm -rf ~`). Splits on the control operators `;`, `&&`, `||`,
 *  `|`, `&` and newlines, and extracts the inner command of every command substitution (`` `…` `` and
 *  `$(…)`) and process substitution (`<(…)` / `>(…)`). Single/double quotes are respected, so a separator inside
 *  a quoted string is NOT a split point. Conservative on malformed input: an unbalanced quote or an unterminated substitution sets
 *  `ambiguous`, telling the resolver to treat the whole line as one segment that can never be granted
 *  by an allow/prefix rule. */
export function splitBashSegments(command: string): { segments: string[]; ambiguous: boolean } {
  const segments: string[] = [];
  const state = { ambiguous: false };
  scanBashLevel(command, segments, state);
  return { segments, ambiguous: state.ambiguous };
}

/** The candidate strings a bash rule pattern is tested against for one simple-command segment: the
 *  segment verbatim (whitespace-normalized) AND its canonical form — leading `VAR=val` assignments and
 *  known wrappers (env/command/sudo/nice) stripped, and the program reduced to its basename — so a rule
 *  like `rm*` catches `/bin/rm`, `FOO=1 rm` and `env rm`, while an args-bearing pattern like `git status*`
 *  still matches the verbatim form. */
function segmentMatchValues(segment: string): string[] {
  const full = segment.replace(/\s+/g, ' ').trim();
  let tokens = full.split(' ').filter(Boolean);
  for (;;) { // strip leading assignments, then unwrap a wrapper — repeat (e.g. `env FOO=1 rm`)
    while (tokens.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) tokens = tokens.slice(1);
    if (tokens.length > 1 && BASH_COMMAND_WRAPPERS.has(basename(tokens[0]!))) { tokens = tokens.slice(1); continue; }
    break;
  }
  if (tokens.length === 0) return [full];
  const canonical = [basename(tokens[0]!), ...tokens.slice(1)].join(' ');
  return canonical === full ? [full] : [full, canonical];
}

/** Resolve one tool call against the ruleset. THE documented semantic: the LAST matching rule in
 *  insertion order wins (defaults come first, user rules after — so a user rule always beats a default,
 *  and within the user's own rules a later entry beats an earlier one; put the catch-all `*` first).
 *  Shell tools resolve in the `bash` scope against the command string (pass `command`); every other
 *  tool resolves in the `tools` scope against its name. No matching rule → `ask` (opencode default). */
export function resolveToolPermission(
  ruleset: readonly PermissionRule[], tool: string, command?: string,
): { action: PermissionAction; pattern: string; scope: PermissionScope } {
  if (command === undefined) {
    for (let i = ruleset.length - 1; i >= 0; i--) {
      const rule = ruleset[i]!;
      if (rule.scope === 'tools' && matchPermissionPattern(tool, rule.pattern)) return { ...rule };
    }
    return { action: 'ask', pattern: '*', scope: 'tools' };
  }
  return resolveBashPermission(ruleset, command);
}

/** Resolve a `bash`-scope command by splitting it into simple-command segments and taking the MOST
 *  RESTRICTIVE decision across all of them: any segment `deny` → deny; else any `ask` → ask; only
 *  `allow` when EVERY segment is allow. This is what closes the chaining bypass — an allow that matched
 *  only the first program can no longer grant the whole line. An ambiguous parse is treated as one
 *  segment that can never resolve to `allow` (the most permissive it gets is `ask`; a `deny` still bites). */
function resolveBashPermission(
  ruleset: readonly PermissionRule[], command: string,
): { action: PermissionAction; pattern: string; scope: PermissionScope } {
  const scope: PermissionScope = 'bash';
  const resolveSegment = (segment: string): { action: PermissionAction; pattern: string; scope: PermissionScope } => {
    const values = segmentMatchValues(segment);
    for (let i = ruleset.length - 1; i >= 0; i--) {
      const rule = ruleset[i]!;
      if (rule.scope === 'bash' && values.some((v) => matchPermissionPattern(v, rule.pattern))) return { ...rule };
    }
    return { action: 'ask', pattern: '*', scope };
  };
  const { segments, ambiguous } = splitBashSegments(command);
  if (ambiguous) {
    const r = resolveSegment(command);
    return r.action === 'deny' ? r : { action: 'ask', pattern: r.action === 'ask' ? r.pattern : '*', scope };
  }
  const resolved = (segments.length ? segments : [command]).map(resolveSegment);
  return resolved.find((r) => r.action === 'deny') ?? resolved.find((r) => r.action === 'ask') ?? resolved[0]!;
}

/** How many leading tokens make the "human-understandable command" for a few common multi-word CLIs —
 *  a deliberately small subset of opencode's arity table. Default (unlisted) is 1 token. */
const BASH_PREFIX_ARITY: Record<string, number> = {
  git: 2, 'git remote': 3, 'git stash': 3,
  npm: 2, 'npm run': 3, pnpm: 2, 'pnpm run': 3, yarn: 2, 'yarn run': 3, bun: 2, 'bun run': 3,
  docker: 2, 'docker compose': 3, cargo: 2, go: 2, make: 2, kubectl: 2, systemctl: 2, gh: 2,
  composer: 2, pip: 2, npx: 2,
};

/** The pattern an "Always allow" pick adds for a shell command: its command prefix plus a trailing `*`
 *  (opencode-style, e.g. `git status --porcelain` → "git status*"). Single-token fallback keeps the
 *  grant narrow: `rm -rf x` suggests "rm*", never "*". An empty command has no safe prefix to persist —
 *  a bare `*` would be allow-all — so it returns null and the approval prompt omits "Always allow". */
export function bashAlwaysPattern(command: string): string | null {
  const tokens = command.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (tokens.length === 0) return null;
  let take = 1;
  for (let len = Math.min(tokens.length, 3); len > 0; len--) {
    const arity = BASH_PREFIX_ARITY[tokens.slice(0, len).join(' ')];
    if (arity !== undefined) { take = arity; break; }
  }
  return `${tokens.slice(0, Math.min(take, tokens.length)).join(' ')}*`;
}

/** One pending approval, as handed to the turn's `requestApproval` (wired only where a human is
 *  attached — owner CLI/web chat). `alwaysPattern` is what an "Always allow" pick persists — null when
 *  there is no safe pattern to offer (empty command), in which case the prompt omits "Always allow". */
export interface ApprovalRequest { tool: string; scope: PermissionScope; command?: string; alwaysPattern: string | null }
export type ApprovalDecision = 'once' | 'always' | 'deny';

/** Everything the execute-time permission gate needs for one turn, threaded through the TurnScope
 *  (AsyncLocalStorage) like the ToolPolicy. Absent scope (task workers, tests) → gate inert. */
export interface TurnPermissions {
  ruleset: PermissionRule[];
  /** Effective YOLO for this turn: the session override when set, else the user's persisted default.
   *  True → `ask` resolves to `allow` without prompting; `deny` rules still deny. */
  yolo: boolean;
  /** Blocking human approval — wired ONLY for owner chat turns (CLI/web). Undefined → the turn is
   *  UNATTENDED (channel/cron/subagent) and `ask` follows `unattendedAsks` instead of prompting. */
  requestApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /** How `ask` resolves on an unattended turn (no `requestApproval`): 'allow' runs (the default —
   *  absent means 'allow'), 'deny' refuses (strict mode; YOLO never overrides it). Mirrors the
   *  persisted {@link PermissionSettings.unattendedAsks}. */
  unattendedAsks?: 'allow' | 'deny';
  /** Persist an "Always allow" pick into the user's stored rules. Best-effort. */
  persistAllow?: (scope: PermissionScope, pattern: string) => void;
}

/** Model-facing summary of the turn's effective permission rules, injected into the live prompt of
 *  owner-chat turns (Alex-style `<runtime_permissions>` idea): when the model can SEE which commands
 *  are pre-approved, it plans around the rules instead of tripping approval prompts it could avoid.
 *  Compact by construction — patterns capped per action, later same-pattern rules override earlier
 *  ones (mirroring last-match-wins), catch-alls rendered as the scope default. */
/** Neutralize a user rule pattern rendered into the model-facing `<permissions>` block: strip newlines
 *  and angle brackets so a crafted pattern cannot inject a fake line or a spoofed `</permissions>` close.
 *  Normal patterns (tool names, `git status*`, `rm*`) contain none of these, so their rendering is
 *  unchanged — sanitizeRuleMap only bounds length/action, not the pattern's characters. */
const sanitizePatternForBlock = (pattern: string): string => pattern.replace(/[\r\n]+/g, ' ').replace(/[<>]/g, '');

export function summarizePermissions(perms: Pick<TurnPermissions, 'ruleset' | 'yolo'>): string {
  const effective = (scope: PermissionScope): Map<string, PermissionAction> => {
    const m = new Map<string, PermissionAction>();
    for (const r of perms.ruleset) if (r.scope === scope) m.set(r.pattern, r.action);
    return m;
  };
  const list = (m: Map<string, PermissionAction>, action: PermissionAction): string => {
    const patterns = [...m].filter(([p, a]) => a === action && p !== '*').map(([p]) => sanitizePatternForBlock(p));
    if (patterns.length === 0) return '';
    const shown = patterns.slice(0, 12);
    if (patterns.length > shown.length) shown.push(`+${patterns.length - shown.length} more`);
    return shown.join(', ');
  };
  const scopeLine = (label: string, m: Map<string, PermissionAction>): string => {
    const parts = [`default ${m.get('*') ?? 'ask'}`];
    for (const action of ['deny', 'allow', 'ask'] as const) {
      const s = list(m, action);
      if (s) parts.push(`${action}: ${s}`);
    }
    return `- ${label}: ${parts.join('; ')}`;
  };
  const lines = [
    '<permissions>',
    "Tool-permission rules this session ('ask' pauses for the user's approval — prefer pre-allowed commands where equivalent, and batch work so approvals come early, not scattered):",
    scopeLine('shell (Bash, matched against the command)', effective('bash')),
    scopeLine('tools (matched by name)', effective('tools')),
  ];
  if (perms.yolo) lines.push('- YOLO active: asks auto-approve this session; deny rules still apply.');
  lines.push('</permissions>');
  return lines.join('\n');
}

/** Option labels of the approval prompt. English on purpose: core wire texts are English (the model
 *  and every surface see them verbatim), mirroring AskUserQuestion. Stable — the decision mapping
 *  below and both frontends key on them. */
export const APPROVAL_LABELS = { once: 'Allow once', always: 'Always allow', deny: 'Deny' } as const;

/** Build the AskQuestion an approval rides the elicitation pipeline with (`ask` event, kind
 *  'approval'). Single-select, no free-text Other — the three options are the whole contract. */
export function approvalQuestion(req: ApprovalRequest): AskQuestion {
  const cmd = req.command ? req.command.replace(/\s+/g, ' ').trim() : '';
  const shownCmd = cmd.length > 200 ? `${cmd.slice(0, 199)}…` : cmd;
  // "Always allow" is offered only when there IS a safe pattern to persist — never for an empty command
  // (its pattern would be an allow-all `*`).
  const options: AskQuestion['options'] = [{ label: APPROVAL_LABELS.once, description: 'run it this time only' }];
  if (req.alwaysPattern) options.push({ label: APPROVAL_LABELS.always, description: `always allow "${req.alwaysPattern}"` });
  options.push({ label: APPROVAL_LABELS.deny, description: 'skip this call' });
  return {
    header: 'Approval',
    question: shownCmd ? `Run this command?\n$ ${shownCmd}` : `Allow the "${req.tool}" tool to run?`,
    multiSelect: false,
    custom: false,
    options,
  };
}

/** Map the user's answer back to a decision. Anything that isn't an explicit allow — a Deny pick, the
 *  elicitation timeout sentinel, a free-text answer — resolves to deny (fail closed). */
export function approvalDecision(answers: AskAnswer[]): ApprovalDecision {
  const selected = answers[0]?.selected ?? [];
  if (selected.includes(APPROVAL_LABELS.always)) return 'always';
  if (selected.includes(APPROVAL_LABELS.once)) return 'once';
  return 'deny';
}
