# Claude Code vs Elowen: Session State, Configuration, and the Project/Repository Layer

> Snapshot: Elowen `0.28.24` in this checkout. Public GitHub/npm remain on `0.28.17`; this is an implementation comparison, not a publication claim.

This document studies one domain of Claude Code (`/tmp/claude-code`, a TypeScript/Bun CLI, read-only clone):
how a session's state is persisted, resumed and forked; how the working directory and accessible paths are
chosen; how configuration is layered across scopes; how project context files are discovered and merged; how
git is used for isolation; and what keeps a long-running instance healthy. It deliberately excludes
context-compaction internals, tool/permission definitions and the turn loop — those are covered in the
sibling documents in this directory.

Claude Code is architecturally a **per-user CLI** that keeps all state in flat files under `~/.claude`
(`CLAUDE_CONFIG_DIR`), one process per session, spawned fresh for every invocation. Elowen is a
**multi-user daemon** with one long-lived process and a single SQLite database
(`/var/www/.config/elowen/elowen.db`, schema in `src/store/schema.sql`) as its sole source of truth. A good
number of Claude Code's mechanisms exist specifically to cope with N independent OS processes racing on
shared JSON files on one laptop — problems Elowen's architecture doesn't have. Where that is the case this
document says so plainly and marks the finding SKIP rather than padding it into a recommendation.

---

## 1. Transcript persistence format and entry types

**Claude Code.** Every session is one append-only JSONL file at
`~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl` (`utils/sessionStorage.ts:198-225`,
`getProjectDir = memoize(cwd => join(getProjectsDir(), sanitizePath(cwd)))`, `utils/sessionStorage.ts:436-438`).
The file interleaves real conversation messages with over a dozen sidecar entry types sharing one `type`
discriminant — `summary`, `custom-title`, `ai-title`, `last-prompt`, `task-summary`, `tag`, `agent-name`,
`agent-color`, `agent-setting`, `pr-link`, `mode`, `worktree-state`, `content-replacement`,
`file-history-snapshot`, `attribution-snapshot`, `speculation-accept`, plus two context-collapse entries
(`types/logs.ts:56-297`). Reading back a session means replaying the whole JSONL and reducing these entries
in order; metadata like a custom title is *re-appended* near the tail on every mutation so a
last-64KB-only reader (`readLiteMetadata`) still finds it (`utils/sessionStorage.ts:2815`
`reAppendSessionMetadata`, comment at `utils/sessionStorage.ts:452-461`). Files can grow to multiple GB;
readers cap themselves at `MAX_TRANSCRIPT_READ_BYTES = 50MB` (`utils/sessionStorage.ts:229`).

**Elowen.** Sessions are rows, not files: `brain_sessions` (one row per conversation, with `work_dir`,
`provider`, `parent_session_id`) and `brain_messages` (one row per turn message) in SQLite
(`src/store/schema.sql:147-189`). The PI agent session itself lives only in memory
(`SessionManager.inMemory`); on daemon start every conversation is rehydrated from these two tables — no
JSONL, no per-project directory sanitization, no tail-window re-append hack, because SQL gives atomic
updates to any row regardless of file size. A `pending` flag on `brain_messages` exists specifically to
survive a daemon restart mid-turn without discarding the turn's tool calls (`schema.sql:174-179`) — the
exact durability problem Claude Code's re-append hack works around, solved by writing progress continuously
instead of racing a good copy into a tail window.

**Verdict: SKIP** (priority: n/a). Elowen's SQL-backed model is not merely "different", it is strictly better
for its architecture: one writer, one file (the DB), transactional updates, no size-cap reader special case.

---

## 2. Session fork / branch

**Claude Code.** `/branch` (`commands/branch/branch.ts:61-173`, `createFork`) copies the current session's
transcript into a brand-new `sessionId`, rewriting the `parentUuid` chain and stamping every copied entry
with `forkedFrom: { sessionId, messageUuid }` for traceability, then resumes into the fork
(`commands/branch/branch.ts:222-296`). It also carries over `content-replacement` entries so the fork's
prompt-cache behaviour doesn't regress (comment at `commands/branch/branch.ts:98-111`). Ordinary
`--resume`/`--continue` instead reuses the *same* `sessionId` and re-points the transcript file pointer
(`utils/sessionRestore.ts:409-489`, `processResumedConversation`); `--fork-session` on that same code path
takes a fresh session id but seeds it with the parent's content-replacement records
(`utils/sessionRestore.ts:452-463`).

**Elowen.** `brain_sessions.parent_session_id` exists, but only for **delegated child sessions** spawned by
the agent itself (subagents/workflow nodes) — there is no user-facing "branch this conversation from here"
action; a conversation's row is 1:1 with its message history (`src/store/schema.sql:162-166`, `195`).

**Gain from adopting.** A cheap, valuable UX primitive: let a user try a different approach from a given
point without losing the original thread.

**Cost/risk.** Low. Unlike Claude Code's file copy, this is one SQL transaction: insert a new
`brain_sessions` row (copy `model`/`provider`/`work_dir`, no `parent_session_id` — a fork is a peer, not a
delegated child), then insert-select the source's `brain_messages` rows with new ids under it. No
corresponding rewind of `brain_subagent_runs`/`brain_cards` sidecars is strictly required (they can start
empty in the fork), which is simpler than Claude Code's `forkedFrom` bookkeeping.

**Verdict: ADOPT**, priority **medium** — small, self-contained, and the closest thing in this whole domain
to a straightforward "port the idea, not the mechanism" win.

---

## 3. What is *not* persisted, restored from a transcript scan instead

**Claude Code.** The TodoWrite tool's state is not written anywhere durable in older ("non-v2") mode — on
resume it is reconstructed by scanning the transcript *backwards* for the last `TodoWrite` tool_use block
and re-parsing its `todos` argument (`utils/sessionRestore.ts:73-93`, `extractTodosFromTranscript`, called
at `utils/sessionRestore.ts:140-149`). This is an O(n) transcript walk on every resume, guarded by a feature
flag (`isTodoV2Enabled()`) that switches to a genuinely file-backed v2 task store instead.

**Elowen.** `brain_cards` persists the last state of any plugin-emitted display panel — including the todo
checklist — directly, keyed by `(session_id, card_id)` (`src/store/schema.sql:221-232`). Reopening a
conversation is an O(1) indexed read, not a transcript scan, and the comment on the table explicitly notes
this is *why* it exists: "closing the chat disposes the live session, so a memory-only panel would take the
user's todo list with it."

**Verdict: SKIP.** Elowen already solved this the way Claude Code's own v2 migration is heading — direct
persistence instead of transcript archaeology.

---

## 4. File checkpoint / rewind (per-turn file snapshots)

**Claude Code.** Before/after every file edit, `fileHistoryTrackEdit` / `fileHistoryMakeSnapshot`
(`utils/fileHistory.ts:86-193`, `198-342`) back up the pre-edit contents of every tracked file to
`~/.claude/file-history/<sessionId>/<sha256(path)>@v<N>` via `copyFile` (`utils/fileHistory.ts:748-798`,
`createBackup`), keyed to the message UUID that produced the change. `fileHistoryRewind`
(`utils/fileHistory.ts:347-397`) restores every tracked file to the version pinned at a given message —
files that didn't exist yet get deleted (`applySnapshot`, `utils/fileHistory.ts:537-591`). Snapshots are
capped at `MAX_SNAPSHOTS = 100` per session (`utils/fileHistory.ts:54`, `305-313`) and diff stats
(`fileHistoryGetDiffStats`, `:414-484`) are shown so a rewind's blast radius is visible before committing to
it. This state is *also* written into the JSONL as `file-history-snapshot` entries so it survives resume
(`utils/sessionStorage.ts:1476-1487`, entry type at `types/logs.ts:189`), and on `--resume` from a different
session id the backup files themselves are hard-linked into the new session's directory
(`utils/fileHistory.ts:922-1046`, `copyFileHistoryForResume`).

**Elowen.** No equivalent exists (verified — no match for "checkpoint", "rewind", or "file snapshot" in
`src/`). An agent turn that damages a file otherwise has no undo path other than the user's own git history
(if the repo is even clean going in).

**Gain from adopting.** A genuine safety net, and arguably more valuable for Elowen than for Claude Code:
Elowen runs autonomous missions and delegated sub-agents unattended, so a bad turn's file damage has no
human watching in real time to undo it before it compounds.

**Cost/risk.** Real, not trivial. This needs: (a) a backup store — binary file blobs do **not** belong in
SQLite the way `brain_messages` JSON does; a `<data-dir>/file-history/<sessionId>/` tree mirroring Claude
Code's own layout is the natural fit; (b) a hook into the file-edit tool boundary — Elowen's file tools are
plugin-owned, so this lands as a plugin using the existing tool hook bus around Edit/Write calls, not as a
first-class Elowen feature; (c) retention/disk-usage bounds and a rewind command wired through the existing
session plumbing; (d) multi-user path scoping so one user's rewind can't touch another's project (Elowen
already has the ACL machinery for this — see finding 7 — it just needs threading through).

**Verdict: ADAPT**, priority **medium-high** — worth building specifically because Elowen's unattended
autonomy makes an undo mechanism more load-bearing than in an interactive CLI, but scope it down: snapshot
before a Write/Edit batch within a turn, one rewind command, no attempt to match Claude Code's full
100-snapshot/diff-stats UI on day one.

---

## 5. Configuration layering (managed → user → project → local → flag)

**Claude Code.** Five setting sources merge low-to-high priority: `userSettings` (`~/.claude/settings.json`),
`projectSettings` (`.claude/settings.json`, checked in), `localSettings` (`.claude/settings.local.json`,
gitignored), `flagSettings` (`--settings` CLI flag / SDK inline), `policySettings` (enterprise-managed) —
declared once in `utils/settings/constants.ts:7-22`. Merge is deep with array concat+dedup
(`utils/settings/settings.ts:529-547`, `settingsMergeCustomizer`), except arrays under a single key which are
wholesale-replaced by `updateSettingsForSource`'s own customizer (`utils/settings/settings.ts:487-491`) — an
inconsistency the codebase itself only reconciles by callsite convention. `policySettings` alone is "first
source wins" rather than merged: remote-managed settings beat Windows HKLM/macOS plist beat
`managed-settings.json` (+ alphabetically-ordered drop-in fragments in `managed-settings.d/`) beat per-user
HKCU (`utils/settings/settings.ts:322-407`, `loadManagedFileSettings` at `:74-121`). Several
security-sensitive settings (bypass-permissions mode, auto-mode opt-in, autoMode allow/deny rules) explicitly
*exclude* `projectSettings` from their read path so a malicious repo can't self-authorize its own agent
(`utils/settings/settings.ts:878-911`, `936-982` — the comments call this out as an RCE guard).

**Elowen.** Two tiers, not five: one instance-wide row in the `settings` table (`src/store/schema.sql:55`,
`ConfigStore` in `src/store/configStore.ts:583-843`) holding admin-set operational config (providers, brain
limits, plugin enablement), and per-user key/value overrides in `user_settings` (`schema.sql:103-109`,
`UserSettingStore` in `src/store/userSettingStore.ts:89-303`) for things like model choice, thinking level,
auto-compact threshold — validated and clamped per field on both read and write so a corrupt row degrades to
defaults rather than throwing (`configStore.ts:586-657`, `userSettingStore.ts:121-217`). There is no
per-project settings file and no enterprise-policy tier.

**Verdict: SKIP** for the managed/enterprise-policy machinery (registry/plist/remote-managed, drop-in merge
order, HKCU fallback) — Elowen is run by one admin who already has direct DB/API access; there is no separate
"IT department manages many users' laptops" actor to serve. One narrower, real gap worth naming without
inflating it into its own finding: Elowen has no **per-project** override tier — a `projects` row
(`schema.sql:1`) can't currently say "this repo needs a longer bash timeout" the way Claude Code's
`.claude/settings.json` can. Priority: **low** — only worth building if/when an actual per-project tuning
need shows up.

---

## 6. Project context files: discovery, merge order, `@include`

**Claude Code.** Documented precisely at the top of `utils/claudemd.ts:1-27`: Managed
(`/etc/claude-code/CLAUDE.md`) → User (`~/.claude/CLAUDE.md`) → Project (`CLAUDE.md`, `.claude/CLAUDE.md`,
`.claude/rules/*.md`, discovered by walking from cwd *up* to the filesystem root, root-to-cwd load order so
closer-to-cwd files win) → Local (`CLAUDE.local.md`, gitignored). Implemented in `getMemoryFiles`
(`utils/claudemd.ts:790-1075`). An `@path` / `@./path` / `@~/path` / `@/path` include syntax is resolved by
lexing the markdown and scanning **text-node tokens only** — code blocks/spans are deliberately skipped
(`utils/claudemd.ts:451-535`, `extractIncludePathsFromTokens`), bounded to `MAX_INCLUDE_DEPTH = 5` (`:537`)
with cycle protection via a `processedPaths` set (`processMemoryFile`, `:618-685`). Includes outside the
project root require one-time user approval (`hasClaudeMdExternalIncludesApproved`, checked at `:798-801`).
`.claude/rules/*.md` files carry YAML frontmatter (`paths: [...]`) that scopes a rule to matching file globs
instead of loading it unconditionally (`processConditionedMdRules`, `:1354-1397`), resolved lazily per file
the agent actually touches rather than eagerly for the whole tree.

**Elowen.** Delegates this entirely to its runtime dependency, PI: `contextFiles: true` tells PI's
`DefaultResourceLoader` to walk `cwd` and its ancestors for `AGENTS.md`/`CLAUDE.md`
(`src/brain/session/factory.ts:86-89, 202-209`). Elowen's own contribution is a leak guard, not a discovery
mechanism: this is switched on **only** for an admin's own private chat, never for a shared channel or a
non-admin user, because the ancestor walk would otherwise pull internal instruction files into a prompt
foreign senders can read (`src/brain/service/spawner.ts:308-313`, explicit comment on the two required
guards). There is no `@include`, no `.claude/rules/`-style path-scoped conditional loading, and no four-tier
managed/user/project/local split.

**Verdict: ADAPT**, priority **low**, with a caveat: the `@include` and glob-scoped conditional-rule
mechanisms are genuinely reusable primitives for splitting a large instruction file into modules, but the
place to build them is **upstream in PI's `DefaultResourceLoader`**, not inside Elowen — Elowen doesn't own
context-file discovery today and duplicating that parsing logic locally would create the exact "two sources
of truth" pattern this project's own conventions warn against. Flag it as a PI feature request rather than
an Elowen task.

---

## 7. Working directory and accessible-path determination

**Claude Code.** `originalCwd` is the real OS process's cwd, set once at startup and used to key the
project's JSONL directory (`sanitizePath(cwd)`, `utils/sessionStorage.ts:436-438`). Entering a git worktree
actually `process.chdir()`s the whole CLI process and clears every cwd-derived cache (memory files, prompt
sections, plans dir) so subsequent reads see the new tree (`utils/worktree.ts:702-778`; resume-time
restoration at `utils/sessionRestore.ts:332-400`, `restoreWorktreeForResume`/`exitRestoredWorktree`). Beyond
cwd, the accessible-path set is widened by an `additionalDirectories` permission setting (`--add-dir`),
consulted through `utils/permissions/filesystem.ts`. This is all solving one problem: **there is exactly one
OS process and it has exactly one real cwd**, which the tool has to fake-relocate for worktrees and
explicitly widen for extra directories.

**Elowen.** Has no real per-session process cwd to fake — it's one daemon serving N users concurrently.
`brain_sessions.work_dir` is a validated-realpath **string column**, not a live OS cwd, used only to drive
which conversation a CLI invocation in a given directory resumes by default (`src/store/schema.sql:158-161`).
Path confinement for what a session's tools can actually touch is enforced by an explicit authorization layer
instead: `user_projects` (many-to-many ACL, `schema.sql:80-83`) plus per-token scoping — an `agent`-scoped
token is confined to its own live working set, computed from `agentProjects()`, never the admin-bypass
"everything" set (`src/api/context.ts:160-296`, `canAccessProject`/`accessibleProjects`/`resolveTarget`).

**Verdict: SKIP.** Claude Code's cwd-juggling and `additionalDirectories` allowlist solve "how does one
process impersonate being in different directories for different invocations", a problem specific to its
single-process-per-session model. Elowen's DB-backed multi-user ACL is not just different, it is the correct
mechanism for a shared daemon and is already strictly stronger (per-user, per-token, auditable).

---

## 8. Concurrent-session discovery (`claude ps`)

**Claude Code.** Every top-level session (interactive, SDK, background, daemon) writes a PID file to
`~/.claude/sessions/<pid>.json` with sessionId/cwd/kind/startedAt, so independent OS processes on the same
machine can discover each other (`utils/concurrentSessions.ts:59-109`, `registerSession`). Liveness is
checked by probing the PID (`isProcessRunning`); a dead PID's stale file is swept on the next read
(`:168-204`, `countConcurrentSessions`).

**Elowen.** Doesn't need cross-process discovery at all — one daemon process holds every live session in an
in-memory `LiveSessionRegistry` with Map-order-as-LRU semantics and an explicit eviction policy that protects
parents with running delegated children (`src/brain/session/liveRegistry.ts:1-10, 131-147`), plus the durable
`brain_sessions` table for anything not currently live.

**Verdict: SKIP.** This is a workaround for having no shared process to hold session state in; Elowen has
exactly that process.

---

## 9. Cost / usage accounting

**Claude Code.** Running per-model totals (tokens, cache read/write, cost) accumulate in a **process-local
in-memory counter** during the session (`cost-tracker.ts:278-323`, `addToTotalSessionCost`). Before an exit
or a session switch, this counter is snapshotted into the project config's `lastCost`/`lastModelUsage` fields
(`cost-tracker.ts:143-175`, `saveCurrentSessionCosts`) and restored on `--resume` **only if** the resumed
session id still matches the config's `lastSessionId` (`cost-tracker.ts:87-137`,
`getStoredSessionCosts`/`restoreCostStateForSession`) — a narrow, single-slot cache that a crash between
turns can simply lose.

**Elowen.** Never keeps a separate running counter to lose. `BrainUsageStore` derives every usage figure on
demand from `$.usage` already embedded in each persisted `brain_messages` assistant row, plus
`$.usageRollup` buckets a compaction folds dropped rows into before deleting them
(`src/store/brainUsageStore.ts:39-74` `USAGE_ROWS`, `:138-195` `rollupDroppedUsage`). Views are cached behind
a cheap sentinel (`MAX(rowid)`/`MAX(updated_at)`) rather than an ad hoc file write, so cost survives a crash
automatically — it was never anywhere but the same durable rows the conversation itself lives in
(`:99-107, 235-253`).

**Verdict: SKIP.** Claude Code's in-memory-counter-plus-snapshot pattern is a real crash-loses-data window
(its own resume-cost-restore code exists specifically to paper over it). Elowen's SQL-derived approach —
compute from what's already durable — is the more robust design.

---

## 10. Graceful shutdown / crash survivability

**Claude Code.** Registers `SIGINT`/`SIGTERM`/`SIGHUP` handlers plus a macOS-specific orphan-TTY poll (the OS
revokes the terminal fd instead of signaling on some disconnects) (`utils/gracefulShutdown.ts:237-297`).
Shutdown runs a strict, bounded sequence: print a resume hint *before* any async work (survives even a
`SIGKILL` mid-cleanup), flush session persistence first with a 2s timeout, then `SessionEnd` hooks, then
analytics capped at 500ms — all guarded by a hard failsafe timer (`max(5000, hookBudget + 3500)`) that
force-exits no matter what hangs (`utils/gracefulShutdown.ts:390-523`). This whole apparatus exists because a
single turn's state lives partly in memory until a clean exit writes it out.

**Elowen.** Takes the opposite strategy and doesn't need the failsafe-timer choreography: `brain_messages`
writes `pending` rows *during* the turn, not only at exit (`schema.sql:174-179`, discussed in finding 1), so
there is no in-memory-only state a shutdown race could lose. `installGracefulShutdown`
(`src/daemon/bootstrap.ts:213-257`) instead **drains**: on `SIGTERM`/`SIGINT` it waits (bounded by
`SHUTDOWN_DRAIN_MS = 600_000`, tied to systemd's `TimeoutStopSec`) for in-flight turns, sub-agents and
undelivered results to finish naturally, announces the stop on chat platforms, and exits 0 either way; a
second signal short-circuits straight to exit.

**Verdict: SKIP.** Both solve "don't lose work on shutdown", via genuinely different and each
appropriately-shaped strategies: Claude Code races a bounded cleanup because its state is transient until
written; Elowen just never lets state be transient, so it can afford to wait instead of racing. A failsafe
timer here would be solving a problem Elowen doesn't have.

---

## 11. Git worktree management (isolation, per-task cleanup)

**Claude Code.** Creates ad hoc git worktrees under `.claude/worktrees/<slug>/` per interactive session, per
sub-agent (`createAgentWorktree`), and per PR review, with optional sparse-checkout, symlinked
`node_modules`-style directories to avoid disk bloat, and a `.worktreeinclude` mechanism to copy gitignored
files a build needs (`utils/worktree.ts:229-504`). A periodic sweep removes stale ephemeral worktrees older
than a cutoff, matched against a strict slug-pattern allowlist and fail-closed on any dirty/unpushed state
(`utils/worktree.ts:1030-1136`, `cleanupStaleAgentWorktrees`).

**Elowen.** Sandbox workspaces provide isolated Git worktrees for delegated work and user conversations:
`SandboxCreateWorkspace` creates a branch/worktree, `SandboxUseWorkspace` binds it to the conversation, and
`resolveDelegatedWorkspace` plus workspace-aware tool composition keep delegated execution on the selected
workspace. Workspace ownership, leases, commits, and cleanup are durable plugin state; there is no core PR-native mission worktree path.

**Verdict: SKIP as a direct port.** Elowen now covers isolation where it is needed, but through explicit
conversation/account-bound Sandbox workspaces rather than an automatic worktree per every session or tool.
The remaining choice is a product/workflow distinction, not a missing Claude Code primitive.

---

## 12. Shared-config-file concurrency safety

**Claude Code.** Because N independent CLI processes can write `~/.claude.json` at once, `saveGlobalConfig`
takes a `proper-lockfile` lock around every write (`utils/config.ts:797-866`, lazy-loaded lock wrapper at
`utils/lockfile.ts:1-43`), falls back to a racy unlocked write if the lock itself fails, and separately guards
against a re-read losing auth state mid-race (`wouldLoseAuthState`, referenced at `utils/config.ts:846-853`).
A background `fs.watchFile` poll picks up another process's write within ~1s so this process's own in-memory
cache doesn't go stale (`utils/config.ts:991-1034`).

**Elowen.** Has no equivalent because it has no equivalent problem: `ConfigStore`/`UserSettingStore` read and
write through `better-sqlite3`, which gives single-process, transactional, no-lockfile-needed writes to the
`settings`/`user_settings` tables (`src/store/configStore.ts:659-662`, `src/store/userSettingStore.ts:104-109`).

**Verdict: SKIP.** Solved architecturally, not by porting a lockfile-plus-freshness-watcher pattern into a
system with exactly one writer.

---

## Summary, ordered by value for effort

| # | Finding | Verdict | Priority | Why |
|---|---|---|---|---|
| 2 | Session fork/branch | **ADOPT** | medium | One SQL transaction gives a real, missing UX primitive; smallest cost of any real gap found. |
| 4 | File checkpoint/rewind per turn | **ADAPT** | medium-high | Genuine capability gap, more valuable for Elowen's unattended autonomy than for an interactive CLI, but real build cost (backup store, plugin hook, retention). |
| 6 | Context-file `@include` + path-scoped conditional rules | **ADAPT** | low | Useful primitives, but belong upstream in PI's resource loader, not duplicated in Elowen. |
| 5 | Per-project settings override tier | **SKIP** (noted) | low | Real but speculative gap; no evidence of present need beyond the existing per-user tier. |
| 1 | JSONL transcript format & entry types | **SKIP** | — | Elowen's SQLite model is already strictly better for a multi-user daemon. |
| 3 | Todo state via transcript scan | **SKIP** | — | Elowen's `brain_cards` already does this the way Claude Code's own v2 migration is heading. |
| 5 | Enterprise policy settings tier (MDM/managed) | **SKIP** | — | No "IT manages many laptops" actor exists in Elowen's single-admin model. |
| 7 | cwd-juggling + `additionalDirectories` | **SKIP** | — | Solves single-process impersonation; Elowen's DB ACL is already the stronger correct mechanism. |
| 8 | PID-file session discovery | **SKIP** | — | Cross-process discovery problem doesn't exist inside one daemon. |
| 9 | In-memory cost counter + snapshot-on-exit | **SKIP** | — | Elowen's SQL-derived usage views are already more crash-safe. |
| 10 | Failsafe-timer graceful shutdown | **SKIP** | — | Elowen's drain-based shutdown is the sounder fit given its continuous-persistence design. |
| 11 | Per-session/sub-agent git worktrees | **SKIP** | — | Elowen already has the one use case that matters (PR-native missions). |
| 12 | Config-file lock + freshness watcher | **SKIP** | — | Single-writer SQLite has no multi-process race to guard against. |

---

*Status note: the Elowen-side claims above were reconciled against this checkout at `0.28.24`; cited paths and
line numbers are illustrative and may move. Findings labelled ADOPT/ADAPT remain proposals unless explicitly
marked implemented.*
