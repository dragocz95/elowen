import type { AskAnswer, AskQuestion } from './events.js';

/** Granular tool permissions (opencode-style): every tool call resolves to one of three actions.
 *  `allow` runs, `deny` returns an error result to the model, `ask` blocks on a human approval prompt
 *  where one is attached (owner CLI/web chat) and resolves to `allow` everywhere else (channel/cron/
 *  subagent turns — deny still denies there; see the execute-time gate in session/capabilities.ts). */
export type PermissionAction = 'allow' | 'ask' | 'deny';

/** Two independent pattern spaces: `tools` matches TOOL NAMES; `bash` matches the COMMAND STRING of
 *  shell tools (see {@link BASH_PERMISSION_TOOLS}) — so "git *" can be allowed while "rm *" is denied
 *  even though both run through the same run_command tool. */
export type PermissionScope = 'tools' | 'bash';

export interface PermissionRule { scope: PermissionScope; pattern: string; action: PermissionAction }

/** The per-user persisted shape (userSettingStore JSON blob under key `permissions`): rule maps keep
 *  their JSON insertion order (it is load-bearing — see {@link resolveToolPermission}), plus the
 *  persisted YOLO default a session's `/yolo` override layers on top of. */
export interface PermissionSettings {
  tools: Record<string, PermissionAction>;
  bash: Record<string, PermissionAction>;
  /** Default YOLO state for new sessions: `ask` resolves to `allow` without prompting (deny still
   *  denies). The CLI `/yolo` command overrides it per session without touching this value. */
  yolo: boolean;
}

/** Tool names whose permission is decided in the `bash` pattern space, against `args.command`. */
export const BASH_PERMISSION_TOOLS: ReadonlySet<string> = new Set(['run_command']);

/** Built-in defaults, conservative but usable: everything not otherwise named is allowed (read-only
 *  tools stay frictionless), file edits ask, and shell commands ask except for a small read-only
 *  allow-list. User rules are appended AFTER these, so any of them can be overridden per user. */
export const DEFAULT_PERMISSION_RULES: readonly PermissionRule[] = [
  { scope: 'tools', pattern: '*', action: 'allow' },
  { scope: 'tools', pattern: 'write_file', action: 'ask' },
  { scope: 'tools', pattern: 'edit_file', action: 'ask' },
  { scope: 'bash', pattern: '*', action: 'ask' },
  { scope: 'bash', pattern: 'git status*', action: 'allow' },
  { scope: 'bash', pattern: 'git diff*', action: 'allow' },
  { scope: 'bash', pattern: 'git log*', action: 'allow' },
  { scope: 'bash', pattern: 'ls', action: 'allow' },
  { scope: 'bash', pattern: 'ls *', action: 'allow' },
  { scope: 'bash', pattern: 'pwd', action: 'allow' },
  { scope: 'bash', pattern: 'cat *', action: 'allow' },
  { scope: 'bash', pattern: 'grep *', action: 'allow' },
  { scope: 'bash', pattern: 'which *', action: 'allow' },
];

const ACTIONS: readonly PermissionAction[] = ['allow', 'ask', 'deny'];
const isAction = (v: unknown): v is PermissionAction => ACTIONS.includes(v as PermissionAction);

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
 *  Never throws; missing/invalid fields fall back to empty rules + YOLO off. */
export function sanitizePermissionSettings(input: unknown): PermissionSettings {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  return {
    tools: sanitizeRuleMap(src.tools),
    bash: sanitizeRuleMap(src.bash),
    yolo: typeof src.yolo === 'boolean' ? src.yolo : false,
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

/** Simple wildcard match (opencode semantics): `*` = zero or more of any character, `?` = exactly one,
 *  everything else literal. Anchored at both ends. */
export function matchPermissionPattern(value: string, pattern: string): boolean {
  const rx = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${rx}$`).test(value);
}

/** Resolve one tool call against the ruleset. THE documented semantic: the LAST matching rule in
 *  insertion order wins (defaults come first, user rules after — so a user rule always beats a default,
 *  and within the user's own rules a later entry beats an earlier one; put the catch-all `*` first).
 *  Shell tools resolve in the `bash` scope against the command string (pass `command`); every other
 *  tool resolves in the `tools` scope against its name. No matching rule → `ask` (opencode default). */
export function resolveToolPermission(
  ruleset: readonly PermissionRule[], tool: string, command?: string,
): { action: PermissionAction; pattern: string; scope: PermissionScope } {
  const scope: PermissionScope = command !== undefined ? 'bash' : 'tools';
  const value = command !== undefined ? command.replace(/\s+/g, ' ').trim() : tool;
  for (let i = ruleset.length - 1; i >= 0; i--) {
    const rule = ruleset[i]!;
    if (rule.scope === scope && matchPermissionPattern(value, rule.pattern)) return { ...rule };
  }
  return { action: 'ask', pattern: '*', scope };
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
 *  grant narrow: `rm -rf x` suggests "rm*", never "*". */
export function bashAlwaysPattern(command: string): string {
  const tokens = command.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (tokens.length === 0) return '*';
  let take = 1;
  for (let len = Math.min(tokens.length, 3); len > 0; len--) {
    const arity = BASH_PREFIX_ARITY[tokens.slice(0, len).join(' ')];
    if (arity !== undefined) { take = arity; break; }
  }
  return `${tokens.slice(0, Math.min(take, tokens.length)).join(' ')}*`;
}

/** One pending approval, as handed to the turn's `requestApproval` (wired only where a human is
 *  attached — owner CLI/web chat). `alwaysPattern` is what an "Always allow" pick persists. */
export interface ApprovalRequest { tool: string; scope: PermissionScope; command?: string; alwaysPattern: string }
export type ApprovalDecision = 'once' | 'always' | 'deny';

/** Everything the execute-time permission gate needs for one turn, threaded through the TurnScope
 *  (AsyncLocalStorage) like the ToolPolicy. Absent scope (task workers, tests) → gate inert. */
export interface TurnPermissions {
  ruleset: PermissionRule[];
  /** Effective YOLO for this turn: the session override when set, else the user's persisted default.
   *  True → `ask` resolves to `allow` without prompting; `deny` rules still deny. */
  yolo: boolean;
  /** Blocking human approval — wired ONLY for owner chat turns (CLI/web). Undefined → `ask` resolves
   *  to `allow` (channel/cron/subagent turns keep their pre-permission behaviour, minus denies). */
  requestApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /** Persist an "Always allow" pick into the user's stored rules. Best-effort. */
  persistAllow?: (scope: PermissionScope, pattern: string) => void;
}

/** Option labels of the approval prompt. English on purpose: core wire texts are English (the model
 *  and every surface see them verbatim), mirroring ask_user_question. Stable — the decision mapping
 *  below and both frontends key on them. */
export const APPROVAL_LABELS = { once: 'Allow once', always: 'Always allow', deny: 'Deny' } as const;

/** Build the AskQuestion an approval rides the elicitation pipeline with (`ask` event, kind
 *  'approval'). Single-select, no free-text Other — the three options are the whole contract. */
export function approvalQuestion(req: ApprovalRequest): AskQuestion {
  const cmd = req.command ? req.command.replace(/\s+/g, ' ').trim() : '';
  const shownCmd = cmd.length > 200 ? `${cmd.slice(0, 199)}…` : cmd;
  return {
    header: 'Approval',
    question: shownCmd ? `Run this command?\n$ ${shownCmd}` : `Allow the "${req.tool}" tool to run?`,
    multiSelect: false,
    custom: false,
    options: [
      { label: APPROVAL_LABELS.once, description: 'run it this time only' },
      { label: APPROVAL_LABELS.always, description: `always allow "${req.alwaysPattern}"` },
      { label: APPROVAL_LABELS.deny, description: 'skip this call' },
    ],
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
