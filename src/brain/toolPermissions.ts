import type { AskAnswer, AskQuestion } from './events.js';
import { collapseWhitespace } from '../shared/text.js';

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

/** The non-destructive shell allow-list: commands that inspect, measure or transform data to stdout.
 *  The single source of truth for "safe to run without asking" — feeding both the built-in defaults
 *  below and the full clamp in NON_DESTRUCTIVE_BASH_RULES, so every gated context sees the same list.
 *  Module-private: callers take the assembled rules, never the bare patterns, so nobody can re-permit
 *  these without the claw-backs. */
const NON_DESTRUCTIVE_BASH_ALLOW: readonly string[] = [
  // `git show` belongs with diff/log: reading a commit is the basic operation of reviewing one, and
  // without it a reviewer can only inspect the working tree and has to guess at history.
  'git status*', 'git diff*', 'git log*', 'git show*',
  'ls', 'ls *', 'pwd', 'cat *', 'grep *', 'which *',
  'head *', 'tail *', 'wc *', 'find *', 'sed *', 'awk *', 'jq *',
  'du *', 'df', 'df *', 'stat *', 'file *', 'diff *', 'sort *', 'uniq *',
  'date', 'date *', 'basename *', 'dirname *', 'realpath *',
  // Bare `env` only: it prints the environment. `env CMD` EXECUTES CMD (env is a wrapper — see
  // BASH_COMMAND_WRAPPERS), so an `env *` pattern would allow-list every command on the system.
  'env',
  // Search and listing. Same shape as grep/find above — they read the tree and print to stdout.
  'rg *', 'fd *', 'tree', 'tree *', 'nl *', 'cut *', 'tr *', 'column *', 'comm *', 'paste *',
  'xxd *', 'od *', 'strings *', 'base64 *', 'readlink *', 'seq *', 'echo *', 'printf *',
  'md5sum *', 'sha1sum *', 'sha256sum *', 'cksum *',
  // Host and process facts. Read-only introspection an agent needs to describe the machine it is on.
  'ps', 'ps *', 'pgrep *', 'free', 'free *', 'uptime', 'whoami', 'id', 'id *', 'groups', 'groups *',
  'hostname', 'uname', 'uname *', 'nproc', 'arch', 'lsblk', 'lsblk *', 'lsof *', 'ss *', 'netstat *',
  'printenv', 'printenv *', 'locale', 'locale *', 'getconf *', 'whereis *', 'command -v *', 'type *',
  // Read-only git plumbing beyond status/diff/log/show. `git branch` is bare-only — `git branch -D`
  // deletes, and unlike the claw-backs below that is a subcommand flag, not an exec escape.
  'git blame*', 'git branch', 'git rev-parse*', 'git ls-files*', 'git ls-tree*', 'git cat-file*',
  'git describe*', 'git shortlog*', 'git show-ref*', 'git merge-base*', 'git name-rev*',
  'git symbolic-ref*', 'git reflog*', 'git stash list*', 'git remote', 'git remote -v',
  'git config --get*', 'git config --list*',
  // Service and log inspection: the read-only systemctl verbs, spelled out rather than `systemctl *`,
  // which would admit start/stop/restart/disable. journalctl reads, but see the --vacuum/--rotate
  // claw-backs — those delete history.
  'systemctl status*', 'systemctl is-active*', 'systemctl is-enabled*', 'systemctl is-failed*',
  'systemctl show*', 'systemctl cat*', 'systemctl list-units*', 'systemctl list-timers*',
  'systemctl list-sockets*', 'journalctl*',
  // Loopback HTTP only, so an agent can probe a service it just described. The host must be local:
  // curl is the exfiltration path, and a pattern like `curl *` would hand it every URL on the
  // internet. Mutating verbs and request bodies are clawed back below.
  'curl*http://127.0.0.1*', 'curl*http://localhost*', 'curl*http://[::1]*',
  // Verification scripts BY NAME. `npm run *` would be `npm run deploy` too — the script body is
  // arbitrary and lives in the repo, so the boundary can only trust the conventional names for
  // "check the code without changing anything".
  'npm test*', 'npm run lint*', 'npm run typecheck*', 'npm run check*', 'npm run test*',
  'npx tsc*', 'npx vitest run*', 'npx eslint*', 'npx prettier --check*',
];

/** The ways an allow-listed command can still run an ARBITRARY PROGRAM or destroy data — re-denied
 *  after the allows wherever the allow-list is assembled (last-match-wins). Deliberately NOT about
 *  file writes: redirection and `--output` are permitted now (see NON_DESTRUCTIVE_BASH_RULES), so a
 *  write-blocking deny here would only pretend the boundary is tighter than it is.
 *   - `git difftool*` / `git mergetool*` and `*--ext-diff*` / `*--extcmd*` / `*GIT_EXTERNAL_DIFF*` — every
 *     path by which git runs an arbitrary external command, which the broad `git diff*` allow would admit;
 *   - `*GIT_CONFIG*=*` / `*GIT_PAGER=*` — a leading env assignment of the GIT_CONFIG* family (GIT_CONFIG,
 *     GIT_CONFIG_GLOBAL/SYSTEM, GIT_CONFIG_COUNT + GIT_CONFIG_KEY_n/VALUE_n, GIT_CONFIG_PARAMETERS) or
 *     GIT_PAGER injects core.pager/diff.external/textconv → arbitrary exec. segmentMatchValues strips
 *     these leading `VAR=val` assignments off the canonical form (so `… git diff` still matches the allow),
 *     but they survive in the VERBATIM value these patterns match; the `=` keeps a safe read of a file
 *     merely NAMED like the var (`cat GIT_CONFIG_notes.md`) out of the net.
 *   - `find*-delete*` / `find*-exec*` / `find*-ok*` — the one inspection command that also deletes files
 *     or runs a program. A filename literally containing "-exec" is a false positive, and fails closed.
 *   - `awk*system(*` — awk spawns a shell from its program text. awk/sed are full interpreters, so a
 *     determined model has other escapes (getline pipes, sed's `e` flag) no pattern list will close:
 *     this clamp is a guardrail against unguided destruction, not a sandbox. */
/** Flags that turn a READING command into "run whatever I hand you". They are denied in every gated
 *  context, because each one launders an already-denied command through a command that is allowed:
 *  `git difftool --extcmd=X` runs X, and `GIT_PAGER=X git log` runs X.
 *
 *  Shared by the interactive defaults and the shell clamp, and in the clamp they are applied LAST — after
 *  the read-only claw-backs — so that re-permitting `git config --list` cannot re-admit
 *  `GIT_PAGER=sh git config --list` along with it. */
const EXEC_ESCAPE_DENY: readonly string[] = [
  'git difftool*', 'git mergetool*', '*--ext-diff*', '*--extcmd*', '*GIT_EXTERNAL_DIFF*',
  '*GIT_CONFIG*=*', '*GIT_PAGER=*',
  'find*-delete*', 'find*-exec*', 'find*-ok*',
  'awk*system(*',
];

const NON_DESTRUCTIVE_BASH_CLAWBACKS: readonly string[] = [
  ...EXEC_ESCAPE_DENY,
  // journalctl reads history — these three subcommands destroy it.
  'journalctl*--vacuum*', 'journalctl*--rotate*', 'journalctl*--flush*',
  // The loopback allow above is for PROBING a local service. These turn the same command into a write
  // against it, and --proxy turns a loopback URL into a request to anywhere.
  'curl*-X *', 'curl*--request*', 'curl*-d *', 'curl*--data*', 'curl*-T *', 'curl*--upload*',
  'curl*-F *', 'curl*--form*', 'curl*--proxy*',
];

/** The full shell clamp for a context that must not run DESTRUCTIVE commands: deny every command,
 *  re-permit the allow-list above, then claw back the exec/delete escapes. Order is load-bearing
 *  (last-match-wins).
 *
 *  WHAT THIS BOUNDARY IS — and is not. It is NOT "cannot write": output redirection (`cat a > b`,
 *  `>>`), `git diff --output=FILE` and `sed -i` are all permitted, so a clamped agent can create or
 *  overwrite any file the daemon's own user can reach. (That is also why the old `*>*` and
 *  `*--output*` denies are gone: once redirection is allowed they would forbid one spelling of a
 *  write while another stays open.) What the clamp removes is the destructive and hard-to-reverse
 *  set (rm/mv/dd/chmod/chown/ln/truncate/mkfs, git commit/push/reset/checkout/clean), package and
 *  process control (npm install/publish, kill), service control (systemctl start/stop/restart —
 *  only the read-only verbs are listed), network access beyond a loopback GET (wget/ssh, and curl to
 *  any host but 127.0.0.1/localhost), privilege escalation (sudo) and the exec escapes clawed back
 *  above.
 *
 *  ONE DELIBERATE HOLE: the conventional verification scripts (`npm test`, `npm run lint|typecheck|
 *  check`) are allowed by NAME, and a script body is arbitrary repo code. A repo whose `test` script
 *  deploys would run that deploy. This is the same bargain as `awk`/`sed` above — the clamp is a
 *  guardrail against unguided destruction, not a sandbox — taken because a planning agent that cannot
 *  run the project's own check has to guess whether its plan compiles.
 *  Shared by the unattended read-only agent boundary (brain/agents/readOnlyBoundary.ts) and by plan
 *  mode (brain/service/turnContextBuilder.ts), so the shell clamp has exactly ONE definition. */
/** What a non-writing context may NOT run. This is a deny-list: everything else is permitted, so an
 *  agent can build, test, install dependencies and reach the network like any other.
 *
 *  The list is what an agent asked to LOOK at a system has no business doing — destroying data, rewriting
 *  history, taking the machine down or gaining privileges it was not given. Patterns are matched against
 *  BOTH the verbatim command and its canonical form (path and `env`/`sudo`/`nice` wrappers stripped — see
 *  segmentMatchValues), which is why `sudo*` catches a privilege escalation that would otherwise unwrap
 *  into an innocent-looking `cat`.
 *
 *  It is a guardrail, not a sandbox, and cannot become one through a longer list: a shell has unbounded
 *  ways to spell the same act (an interpreter, a script, a here-doc). What it removes is the unguided
 *  destruction an agent stumbles into, not what a determined one could still reach. */
const DESTRUCTIVE_BASH_DENY: readonly string[] = [
  // Erase, overwrite or relocate data.
  'rm *', 'rmdir *', 'shred *', 'truncate *', 'dd *', 'mv *',
  // Filesystem and device surgery.
  'mkfs*', 'fdisk*', 'parted*', 'mount *', 'umount *', 'swapoff*', 'losetup*',
  // Ownership and access bits — a wrong chmod is as unrecoverable as a delete.
  'chmod *', 'chown *', 'chgrp *', 'ln *',
  // Git operations that rewrite, discard or PUBLISH work. Reading history stays open.
  'git reset*', 'git checkout*', 'git restore*', 'git clean*', 'git push*', 'git commit*',
  'git rebase*', 'git merge *', 'git revert*', 'git cherry-pick*', 'git am*', 'git apply*',
  'git filter-branch*', 'git update-ref*', 'git gc*', 'git prune*', 'git reflog delete*',
  'git reflog expire*', 'git branch -d*', 'git branch -D*', 'git branch --delete*',
  'git tag -d*', 'git remote remove*', 'git remote set-url*',
  'git worktree remove*', 'git worktree prune*', 'git submodule deinit*',
  // Denied as a whole, then narrowed back to their reading forms in READ_ONLY_CLAWBACK_ALLOW. A bare
  // `git stash` pockets the user's uncommitted work, and a bare `git config k v` writes — both are
  // mutations wearing the same verb as `git stash list` and `git config --get`.
  'git stash*', 'git config *',
  // Privilege escalation. Matched on the verbatim form — the canonical one has the wrapper stripped.
  'sudo*', 'su *', 'doas*', 'pkexec*',
  // Service control. The read-only verbs (status/show/cat/list-*/is-*) stay available.
  'systemctl start*', 'systemctl stop*', 'systemctl restart*', 'systemctl reload*',
  'systemctl enable*', 'systemctl disable*', 'systemctl mask*', 'systemctl unmask*',
  'systemctl kill*', 'systemctl daemon-reload*', 'systemctl isolate*', 'systemctl set-*',
  'service *', 'initctl*', 'launchctl*', 'systemd-run*',
  // Process termination — including this daemon and its own agents.
  'kill *', 'kill-*', 'pkill*', 'killall*',
  // Taking the host down.
  'shutdown*', 'reboot*', 'halt*', 'poweroff*', 'init *', 'telinit*',
  // Publishing is irreversible in a way installing is not: npm forbids reusing a version number.
  'npm publish*', 'yarn publish*', 'pnpm publish*', 'npm unpublish*', 'npm deprecate*',
  'npm owner*', 'npm access*', 'npm token*', 'cargo publish*', 'twine upload*', 'gem push*',
  // Accounts, scheduled work and firewall state — persistent changes to the machine itself.
  'useradd*', 'userdel*', 'usermod*', 'groupadd*', 'groupdel*', 'passwd*', 'chpasswd*',
  'crontab *', 'at *', 'iptables*', 'ip6tables*', 'nft *', 'ufw *', 'firewall-cmd*',
  // Destructive subcommands of otherwise readable tools.
  'journalctl*--vacuum*', 'journalctl*--rotate*', 'journalctl*--flush*',
  'docker rm*', 'docker system prune*', 'docker volume rm*', 'docker network rm*',
  'docker kill*', 'docker stop*', 'docker-compose down*', 'docker compose down*',
  // Elowen's own control plane: an inspecting agent must not stop the daemon it is running inside.
  'elowen down*', 'elowen update*', 'elowen install*', 'elowen setup*',
];

/** The shell boundary for a context that must not CHANGE things: everything is permitted except the
 *  destructive set above.
 *
 *  This was an allow-list until it proved to be the wrong shape. A read-only agent is not malicious — it
 *  has been told to investigate and report — and enumerating in advance every command an investigation
 *  might need is impossible. What the allow-list actually produced was agents blocked on ordinary work
 *  (a build, a dependency install, fetching a page of documentation) that gave up and reported nothing
 *  useful, while the genuinely dangerous commands were never the ones being reached for.
 *
 *  WHAT IT GUARANTEES: no deletion, no history rewrite, no privilege escalation, no service or host
 *  control, no publishing. It does NOT prevent writing a file — redirection and `sed -i` were already
 *  permitted before this change, so "read-only" has always named the toolset (no Write/Edit) rather than
 *  an airtight write barrier.
 *
 *  Shared by the unattended read-only agent boundary (brain/agents/readOnlyBoundary.ts) and by plan mode
 *  (brain/service/turnContextBuilder.ts), so the shell boundary has exactly ONE definition. Both layer
 *  the operator's own DENY rules on afterwards, so a command an operator forbade stays forbidden. */
/** Reading forms of commands DESTRUCTIVE_BASH_DENY had to deny wholesale, because the mutating and the
 *  reading form share a verb. Applied after the denies, before the exec escapes. */
const READ_ONLY_CLAWBACK_ALLOW: readonly string[] = [
  'git stash list*', 'git config --get*', 'git config --list*', 'git config -l*',
];

export const NON_DESTRUCTIVE_BASH_RULES: readonly PermissionRule[] = [
  { scope: 'bash', pattern: '*', action: 'allow' },
  ...DESTRUCTIVE_BASH_DENY.map((pattern) => ({ scope: 'bash' as const, pattern, action: 'deny' as const })),
  ...READ_ONLY_CLAWBACK_ALLOW.map((pattern) => ({ scope: 'bash' as const, pattern, action: 'allow' as const })),
  ...EXEC_ESCAPE_DENY.map((pattern) => ({ scope: 'bash' as const, pattern, action: 'deny' as const })),
];

/** Built-in defaults, conservative but usable: everything not otherwise named is allowed (read-only
 *  tools stay frictionless), file edits ask, and shell commands ask except for the inspection
 *  allow-list — with the same claw-backs, so `find . -delete` or a pager/config injection never runs
 *  silently here either. User rules are appended AFTER these, so any of them can be overridden per user. */
const DEFAULT_PERMISSION_RULES: readonly PermissionRule[] = [
  { scope: 'tools', pattern: '*', action: 'allow' },
  { scope: 'tools', pattern: 'Write', action: 'ask' },
  { scope: 'tools', pattern: 'Edit', action: 'ask' },
  { scope: 'bash', pattern: '*', action: 'ask' },
  ...NON_DESTRUCTIVE_BASH_ALLOW.map((pattern) => ({ scope: 'bash' as const, pattern, action: 'allow' as const })),
  ...NON_DESTRUCTIVE_BASH_CLAWBACKS.map((pattern) => ({ scope: 'bash' as const, pattern, action: 'deny' as const })),
];

/** Drop rules that a later identical rule already decides, keeping the LAST occurrence so resolution is
 *  unchanged: `resolveToolPermission` scans from the end and takes the first match, so an earlier
 *  duplicate of the same scope+action+pattern can never be the one that wins. Both places that clamp a
 *  ruleset (the read-only agent boundary and plan mode) re-assert the operator's denies after the clamp,
 *  which appends a second copy of every deny already present; those copies change nothing but still count
 *  against MAX_BOUNDARY_RULES. */
export function dedupeRulesKeepingLast(rules: readonly PermissionRule[]): PermissionRule[] {
  const seen = new Set<string>();
  const reversed: PermissionRule[] = [];
  for (const rule of [...rules].reverse()) {
    const key = `${rule.scope}\u0000${rule.action}\u0000${rule.pattern}`;
    if (seen.has(key)) continue;
    seen.add(key);
    reversed.push(rule);
  }
  return reversed.reverse();
}

const ACTIONS: readonly PermissionAction[] = ['allow', 'ask', 'deny'];
const isAction = (v: unknown): v is PermissionAction => ACTIONS.includes(v as PermissionAction);
const isPermissionScope = (v: unknown): v is PermissionScope => v === 'tools' || v === 'bash';
/** 13 built-ins + at most 200 user rules in each map (400) is 413 before anything is layered on, and the
 *  non-destructive shell clamp appends 132 more — so a fully-populated operator ruleset reaches ~545 and
 *  the old 512 cap rejected it, taking down read-only delegation and plan-mode turns for exactly the
 *  operators who configure the most. The cap exists to bound per-call resolution cost (a pattern is
 *  compiled per rule per segment), not to limit the operator, so it sits above the worst reachable case. */
const MAX_BOUNDARY_RULES = 1024;
const MAX_BOUNDARY_PATTERN_CHARS = 200;
/** Cap on the number of user rules kept per sanitized map (distinct from the pattern-length cap above). */
const MAX_RULES_PER_MAP = 200;

/** Keep a user's rule maps bounded and well-typed. Invalid keys/actions are dropped (the blob is
 *  untrusted JSON); insertion order of the surviving entries is preserved — it decides precedence. */
function sanitizeRuleMap(input: unknown): Record<string, PermissionAction> {
  const src = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const out: Record<string, PermissionAction> = {};
  let count = 0;
  for (const [pattern, action] of Object.entries(src)) {
    if (count >= MAX_RULES_PER_MAP) break; // a runaway blob must not balloon per-call rule matching
    if (!pattern.trim() || pattern.length > MAX_BOUNDARY_PATTERN_CHARS || !isAction(action)) continue;
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
  const flush = (): void => { const s = collapseWhitespace(current); if (s) segments.push(s); current = ''; };
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
 *  segment verbatim (whitespace-normalized) FIRST, then its canonical form — leading `VAR=val`
 *  assignments and known wrappers (env/command/sudo/nice) stripped, and the program reduced to its
 *  basename — so a rule like `rm*` catches `/bin/rm`, `FOO=1 rm` and `env rm`. The verbatim form is
 *  always index 0: resolveBashPermission grants an `allow` on that form ALONE, because the canonical
 *  form is there to stop a deny being dodged and must never hand out a permission instead. */
function segmentMatchValues(segment: string): string[] {
  const full = collapseWhitespace(segment);
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
    const verbatim = values[0]!;
    for (let i = ruleset.length - 1; i >= 0; i--) {
      const rule = ruleset[i]!;
      if (rule.scope !== 'bash') continue;
      // ASYMMETRY, and it is the point: the canonical form may only ever tighten a decision, never grant
      // one. It exists so a deny cannot be dodged by spelling the program differently (`/bin/rm`, `env rm`,
      // `FOO=1 rm`) — but matching an ALLOW against it inverts that: `./tools/cat x` and
      // `LD_PRELOAD=payload.so git status` both canonicalize straight onto an allow-listed pattern while
      // running something else entirely. An allow therefore matches the VERBATIM command only; anything
      // spelled with a path or a leading assignment falls through to the surrounding rule (`ask` by
      // default, `deny` under the read-only clamp) instead of inheriting a permission it never earned.
      const candidates = rule.action === 'allow' ? [verbatim] : values;
      if (candidates.some((v) => matchPermissionPattern(v, rule.pattern))) return { ...rule };
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
  const tokens = collapseWhitespace(command).split(' ').filter(Boolean);
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
  const cmd = req.command ? collapseWhitespace(req.command) : '';
  const shownCmd = cmd.length > 200 ? `${cmd.slice(0, 199)}…` : cmd;
  // "Always allow" is offered only when there IS a safe pattern to persist — never for an empty command
  // (its pattern would be an allow-all `*`).
  const options: AskQuestion['options'] = [{ label: APPROVAL_LABELS.once, description: 'run it this time only', id: 'once' }];
  if (req.alwaysPattern) options.push({ label: APPROVAL_LABELS.always, description: `always allow "${req.alwaysPattern}"`, id: 'always' });
  options.push({ label: APPROVAL_LABELS.deny, description: 'skip this call', id: 'deny' });
  return {
    header: 'Approval',
    question: shownCmd ? `Run this command?\n$ ${shownCmd}` : `Allow the "${req.tool}" tool to run?`,
    multiSelect: false,
    custom: false,
    options,
    // The same facts the English above was built from. A surface that renders in another language composes
    // its own sentence from these; the labels it posts back stay the English wire values either way.
    approval: {
      tool: req.tool,
      ...(shownCmd ? { command: shownCmd } : {}),
      ...(req.alwaysPattern ? { alwaysPattern: req.alwaysPattern } : {}),
    },
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
