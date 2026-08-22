# Claude Code's Tool System and Safety Layer — vs. Elowen

Domain: how Claude Code defines tools, writes their prompts, decides whether a call is permitted, lets
hooks intervene, guards file and shell execution, namespaces MCP tools, shapes/truncates results, and
limits what is advertised to the model at any moment. Explicitly out of scope: context compaction, the
turn loop, session persistence (other investigators cover those); mentioned here only where they touch
tool execution.

Source read: `/tmp/claude-code`, a read-only clone at commit `6f6f12b3` (2026-05-07). This is TypeScript/Bun
source, not officially published — mechanisms are described in prose and cited by `path:line`; no code is
copied verbatim. Elowen is `/var/www/elowen` at v0.27.80, branch `main`, built on PI
(`@earendil-works/pi-coding-agent`).

Each finding: what Claude Code does, the mechanism, what Elowen does today, the gain from adopting it, cost/
risk, and a verdict (**ADOPT** / **ADAPT** / **SKIP**) with priority. The summary table is at the end,
ordered by value-for-effort.

---

## 1. Rich per-tool metadata contract vs. PI's thin `ToolDefinition`

**Claude Code.** Every tool is built through `buildTool()`, which fills in safe fail-closed defaults for a
set of "defaultable" methods and lets each tool override them (`Tool.ts:707-792`). The `Tool` type
(`Tool.ts:362-695`) carries, beyond `name`/`inputSchema`/`call`, per-*input* predicates:
`isReadOnly(input)`, `isConcurrencySafe(input)`, `isDestructive(input)` (default `false`, only set for
irreversible ops — `Tool.ts:404-406`), `isOpenWorld(input)` (network-reaching), `requiresUserInteraction()`
(bypass-immune even in `bypassPermissions` mode — `Tool.ts:435`), `interruptBehavior()` (`'cancel'|'block'`
on a new user message — `Tool.ts:407-416`), `isSearchOrReadCommand(input)` (drives UI collapsing —
`Tool.ts:417-433`), `shouldDefer`/`alwaysLoad` (tool-search deferral — `Tool.ts:438-449`),
`maxResultSizeChars` (per-tool disk-spill threshold, `Infinity` to opt out — `Tool.ts:456-466`), and
`toAutoClassifierInput(input)` (compact string fed to the auto-mode LLM classifier — `Tool.ts:550-556`).
Crucially these are functions of the *input*, not static tool properties: `BashTool.isReadOnly` inspects the
actual command (`BashTool.tsx:437-441`) so `git diff` and `git commit` — same tool — get different
answers. `TOOL_DEFAULTS` (`Tool.ts:757-769`) makes the missing case fail closed: `isConcurrencySafe` and
`isReadOnly` default to `false`.

**Elowen.** PI's `ToolDefinition`
(`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:337-370`)
has none of this. The only execution-shape knob is a **static** `executionMode?: 'sequential'|'parallel'`
(`types.d.ts:356-363`) — not input-dependent, and no Elowen plugin sets it
(`grep executionMode plugins/**/*.mjs` → no hits). Elowen recovers read-only-ness and destructiveness a
different way: as external, tool-*name* allow-lists rather than tool-*input* predicates —
`READ_ONLY_AGENT_TOOLS` (`src/brain/agents/agentRegistry.ts:20-35`) for sub-agents, `PLAN_MODE_WRITE_TOOLS`
(`src/brain/session/capabilities.ts:130`) for plan mode, and for Bash specifically the
`NON_DESTRUCTIVE_BASH_ALLOW` / `DESTRUCTIVE_BASH_DENY` pattern lists
(`src/brain/toolPermissions.ts:53-93,170-172`) — which *does* achieve per-command granularity, just via glob
matching on the command string rather than an `isReadOnly(input)` function.

**Gain.** For Elowen's small, hand-authored native tool set the practical gap is narrow: Bash already has
per-command granularity through the pattern lists, and file/network tools are inherently one-shot
read-or-write so a name-level allow-list is already accurate. The gap is real only for a future tool that is
sometimes read, sometimes write, depending on input (an MCP tool is the obvious case, and Elowen cannot
express "this specific MCP call is read-only" today).

**Cost/risk.** Low cost to add an optional `isReadOnly?(params)` convention to Elowen's own `defineTool`
wrapper and consult it in `readOnlyBoundary.ts` / `PLAN_MODE_WRITE_TOOLS`; but it only pays off once a tool
actually needs input-dependent classification, which none currently do.

**Verdict: ADAPT, low priority.** Nothing is broken today; worth doing opportunistically the next time an MCP
or plugin tool needs finer-grained read/write classification than a name can express.

---

## 2. Two-tier tool description (short vs. full) — mechanism exists in PI, unused in Elowen

**Claude Code.** Every tool separates `description(input, opts)` — a short, cheap string used for
ToolSearch keyword matching and UI labels — from `prompt(opts)` — the full multi-paragraph guidance actually
sent as the tool's API description (`Tool.ts:386-393,518-523`). `BashTool` is a clean example:
`description()` returns the one-line `description` field or `'Run shell command'`
(`BashTool.tsx:426-430`); `prompt()` calls `getSimplePrompt()` (`BashTool.tsx:431-433`), a much longer,
static (not model-generated) guidance block. Both are hand-written strings, not templated from the schema.

**Elowen.** PI's `ToolDefinition` already exposes this split structurally:
`description` (sent to the LLM as the tool schema description) plus an optional `promptSnippet` — "one-line
snippet for the Available tools section in the default system prompt... Custom tools are omitted from that
section when this is not provided" (`types.d.ts:344-345`) — and `promptGuidelines` (bullets appended to the
system prompt's Guidelines section, `types.d.ts:346-347`). No Elowen plugin uses either
(`grep -r promptSnippet plugins/` → no hits): every plugin tool (`plugins/files/index.mjs:770-966`,
`plugins/terminal/index.mjs`, etc.) sets only `description`, often several sentences long (e.g. the `Read`
tool's seven-sentence description at `plugins/files/index.mjs:772-780`).

**Gain.** `promptSnippet` is not exactly Claude Code's split (it doesn't change what's sent as the tool
*schema* description; it adds a second, lighter appearance in the system prompt's tool listing), so this
would not shrink the per-call schema cost the way Claude Code's split does. Its value for Elowen is
narrower: letting the always-visible "Available tools" section stay terse while the full multi-sentence
guidance stays in `description` for when the model actually needs it.

**Cost/risk.** Trivial — add one field per tool definition. Non-cache-affecting since it doesn't change the
`tools` schema block itself, only a system-prompt section.

**Verdict: SKIP.** The mechanism exists and costs nothing to try, but it doesn't address the thing that
actually matters for this codebase (prompt-cache cost of the `tools` array) — Elowen's existing single
`description` field already serves the model fine, and splitting it only helps a UI section, not the cached
prefix. Not worth the churn of touching every plugin's tool definitions for a cosmetic-only win.

---

## 3. Layered, explicitly-ordered permission pipeline with bypass-immune safety checks

**Claude Code.** `hasPermissionsToUseToolInner` (`permissions.ts:1158-1319`) runs a numbered, commented
sequence: 1a) tool-level deny rule → deny; 1b) tool-level ask rule → ask (unless sandboxed Bash can
auto-allow, `permissions.ts:1189-1206`); 1c) call `tool.checkPermissions()`; 1d) a tool-level deny from that
call wins outright; **1e) `requiresUserInteraction()` wins even in `bypassPermissions` mode**
(`permissions.ts:1230-1236`); **1f) a content-specific `ask` rule (e.g. `Bash(npm publish:*)`) wins even in
bypass mode** (`permissions.ts:1238-1250`); **1g) "safety checks" (`.git/`, `.claude/`, `.vscode/`, shell
configs) are bypass-immune and fire even when a `PreToolUse` hook already said allow**
(`permissions.ts:1252-1260`); only then 2a) does `bypassPermissions`/plan-with-bypass-available short-circuit
to allow (`permissions.ts:1262-1281`); 2b) whole-tool allow rule; 3) anything left over ("passthrough")
becomes `ask`. The ordering itself is the security property: a handful of checks (1e/1f/1g) are placed
*before* the bypass check specifically so no permission mode, including full bypass, can silence them.

**Elowen.** `gatePermissions` (`src/brain/session/capabilities.ts:168-211`) is a single linear function, not
a numbered pipeline: plan-write clamp first (`planWriteDenial`, itself unconditional —
`capabilities.ts:142-153`), then `resolveToolPermission` against the ordered ruleset (last-match-wins,
`toolPermissions.ts:518-...`), `deny` → refuse, `ask` → either the approval channel or the
`unattendedAsks` fallback (`capabilities.ts:183-206`), else allow. There is no `bypassPermissions`-analogue
to be immune *from* — YOLO (`perms.yolo`) only skips the human prompt for rules that would `ask`; a `deny`
rule is never overridden by YOLO (`capabilities.ts:161-163` doc comment, enforced at 192: the YOLO branch is
only reached after the `deny` return at 181). There is no separate "safety check" category that survives
even a rule saying allow — Elowen has no rule ever *saying* allow-despite-being-dangerous in the first
place, because `deny` is unconditional by construction, so the CC-specific problem (bypass mode blindly
overriding a legitimately-dangerous action) doesn't arise the same way.

**Gain.** Marginal. Elowen's simpler model (deny always wins, YOLO only touches `ask`) already gives the
bypass-immunity property Claude Code has to hand-carve exceptions for (1e/1f/1g) — because Elowen never has
a mode that overrides `deny` in the first place. Importing CC's staged pipeline would add complexity to
regain a guarantee Elowen's simpler design already has.

**Verdict: SKIP — Elowen's model is arguably better here.** It gets bypass-immunity as a structural
consequence of "deny always wins, no mode ever overrides a deny rule" instead of needing three separate
carve-outs (1e/1f/1g) to patch holes that only exist because `bypassPermissions` is allowed to override rules
at all.

---

## 4. Fail-closed LLM classifier for auto/YOLO mode, with a denial-limit circuit breaker

**Claude Code.** In `auto` mode (and in `plan` mode with auto engaged), instead of prompting the human, an
`ask` decision is handed to a classifier: cheap allow-list checks first (`acceptEdits`-equivalent check,
`permissions.ts:600-655`; static safe-tool allowlist, `permissions.ts:660-686`), then an actual LLM call —
`classifyYoloAction` (`permissions.ts:689-699`) — is shown the transcript and the pending action and returns
allow/block with a reason. If the classifier is unreachable, the **default is fail-closed**: `deny` with a
retry message (`permissions.ts:845-869`); only an explicit flag flip makes it fail-open. A separate circuit
breaker tracks consecutive/total denials (`denialTracking.ts`, `DENIAL_LIMITS`) and once a limit is hit, auto
mode gives up and falls back to prompting the human (or aborts entirely in headless mode) —
`handleDenialLimitExceeded` (`permissions.ts:984-1058`).

**Elowen.** YOLO is a static boolean (`PermissionSettings.yolo`, `toolPermissions.ts:33-38,192`, doc comment
at `capabilities.ts:161-163`): an `ask` rule with a human approval channel attached resolves to allow without
prompting, full stop. There is no secondary judgment step, no transcript-aware classifier, and no
consecutive-denial circuit breaker — YOLO simply removes the human from every `ask` for the rest of the
session (or until toggled off).

**Gain.** A classifier step would catch YOLO-mode actions that slipped past the static allow/deny/ask rules
but are contextually dangerous given what the conversation has been doing (Claude Code's actual use case).

**Cost/risk.** Real and recurring: a classifier call is an extra LLM invocation on *every* `ask`-turned-allow
action in YOLO mode — latency and ongoing inference spend, not a one-time build cost. It also adds a new
failure mode (classifier unavailable → must decide fail-open/fail-closed) that has to be gotten right.

**Verdict: SKIP.** The recurring per-action inference cost cuts directly against Elowen's cost-conscious
design elsewhere (e.g. the prompt-cache-preserving `ToolSearch` deferral threshold,
`deferralPolicy.ts:35-38`). Elowen's static rule set plus an explicit, auditable `unattendedAsks` and `yolo`
toggle is a legible, zero-recurring-cost tradeoff a user chooses deliberately; a hidden LLM judge would be
more capable but also more expensive and less predictable than what YOLO mode is for. If ever revisited, the
denial-limit circuit breaker alone (no classifier, just "N consecutive YOLO-approved actions → pause and ask
the human") is a much cheaper partial version worth considering separately.

---

## 5. Hook system: rich lifecycle events, PreToolUse can allow/deny/ask *and rewrite the input*

**Claude Code.** Hooks are user-configured **external shell commands** (or HTTP/agent hooks) declared in
settings, run at 26 lifecycle events (`entrypoints/sdk/coreTypes.ts:25-53`): `PreToolUse`, `PostToolUse`,
`PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`, `SessionStart/End`, `Stop`, `PreCompact`/
`PostCompact`, `UserPromptSubmit`, `Elicitation(Result)`, `FileChanged`, `CwdChanged`, etc. A `PreToolUse`
hook receives `tool_name`/`tool_input`/`tool_use_id` (`executePreToolHooks`, `hooks.ts:3394-3436`) and its
JSON stdout can set `hookSpecificOutput.permissionDecision` to `allow`/`deny`/`ask`
(`hooks.ts:593-614`) **and** `updatedInput` — the hook can rewrite the tool's arguments before it runs
(`types/hooks.ts:76`, applied at `hooks.ts:618-619`). Hooks can also run asynchronously in the background and
wake the model later via a queued notification (`executeInBackground`, `hooks.ts:184-246`). When a
headless/background agent can't show a permission prompt, `PermissionRequest` hooks get one last chance to
decide before an automatic deny (`runPermissionRequestHooksForHeadlessAgent`, `permissions.ts:400-471`).

**Elowen.** `PluginHookBus` (`src/plugins/hookBus.ts:70-206`) is a comparable-*shaped* mechanism — capability-
gated, timeout-bounded, fail-open on throw/timeout, with an audit ring (`src/shared/hookAudit.ts`) — but it
is **in-process JavaScript code inside an installed plugin**, not an end-user-configurable external command.
Its event surface (`PluginHookName`, `src/plugins/api.ts:68-76`) is narrower and coarser:
`tools.call.before`/`tools.call.after` fire for every tool call regardless of which tool, with no
per-tool-name matcher the way Claude Code's hooks can be scoped to `Bash(git *)`
(`BashTool.tsx:445-467`, `preparePermissionMatcher`). `tools.call.before` can only return a deny reason
(`denyToolCall`, `api.ts:83-86`) — it cannot rewrite the input the way Claude Code's `updatedInput` can, and
it runs strictly *after* Elowen's own permission gate (`capabilities.ts:99-102`), so a plugin hook can only
narrow what the user's rules already allowed, never reshape it.

**Gain.** Two distinct things are missing, worth separating: (a) input rewriting from a veto hook — genuinely
useful (e.g. auto-redacting a secret from a command before it runs) and cheap to add to the existing
`gateToolAccess` wrapper; (b) exposing hooks as end-user-configurable *external* commands the way Claude
Code does — this is the part that would let a project's checked-in config auto-run arbitrary shell commands
on every tool call, which is a well-documented supply-chain risk surface for Claude Code and not one Elowen
currently has.

**Cost/risk.** (a) is low cost, no new attack surface (it's still code the operator installed as a plugin).
(b) is a materially different security posture — Elowen's plugins are installed/reviewed by the operator;
Claude Code's hooks are typically configured per-project and can travel with a shared repo, which is exactly
the risk Anthropic's own hook docs warn about.

**Verdict: ADAPT, medium priority** — add input-rewriting to `tools.call.before` (small, contained change);
**explicitly SKIP** externalizing hooks into user-configurable shell commands — that imports a known
supply-chain risk Elowen's current "hooks are plugin code, not project config" design avoids by
construction.

---

## 6. File-edit stale-write guard: Claude Code uses mtime + content fallback, Elowen uses a content hash

**Claude Code.** Both `validateInput` (pre-flight, `FileEditTool.ts:275-311`) and the actual write
(`FileEditTool.ts:451-468`) compare the file's current mtime (`getFileModificationTime`) against the
timestamp recorded at last read (`readFileState`, keyed by absolute path). If the file was never read, or
was only partially read (`isPartialView`), the edit is refused (`errorCode: 6`, line 276-287). If mtime
advanced, it does **not** immediately fail — because mtime can change without content changing (cloud sync,
antivirus, "on Windows timestamps can change without content changes" — the comment at
`FileEditTool.ts:293-295` and `456-457` says so explicitly) — so for a *full* read it falls back to a direct
content-string comparison before declaring `FILE_UNEXPECTEDLY_MODIFIED_ERROR` (`FileEditTool.ts:296-309,
458-467`).

**Elowen.** `markFileRead`/`readGuardError` (`plugins/files/index.mjs:465-545`) record a **SHA-256 content
hash**, not a timestamp, per `(sessionId, absolutePath)`, and `readGuardError` compares hashes, not mtimes.
`Read` records the hash of the bytes it actually saw (`index.mjs:804,811,843,876`); `Edit`/`Write` record the
hash of what they just wrote (`index.mjs:909,957`) so a tool's own write doesn't trip its own guard on a
later call. Both `Write` and `Edit` additionally serialize same-file mutations through
`withFileMutationQueue` (`index.mjs:902,942`) so the guard-check-then-write is atomic against concurrent
edits to the *same* file, while different files still run in parallel.

**Gain from adopting Claude Code's approach: none.** Elowen's hash comparison is strictly more correct — it
is immune by construction to the exact false-positive Claude Code has to special-case with a content-string
fallback (mtime moves without content changing), and it doesn't need the "was this a full read, not a
partial one" special case either, since the hash is computed over the whole file at read time regardless.

**Verdict: SKIP — Elowen's mechanism is already better than Claude Code's.** Content hashing is a strictly
stronger invariant than mtime + fallback, and Elowen already has it plus a per-file mutation queue Claude
Code's version doesn't call out at all. No action needed.

---

## 7. Shell-command safety classification: tree-sitter AST (fail-closed) vs. Elowen's hand-rolled segmenter

**Claude Code.** `parseForSecurity` (`utils/bash/ast.ts:1-19` and onward) parses the command with
**tree-sitter-bash** and walks the tree against an **explicit allowlist of node types**; anything not on the
allowlist makes the whole command `'too-complex'`, which routes it back through the full ask flow instead of
ever being classified as safe (`ast.ts:8-19`, "the entire command to be classified as 'too-complex'...
FAIL-CLOSED: we never interpret structure we don't understand"). It returns real `argv[]` per simple command
(`SimpleCommand.argv`) with env-var assignments and redirects already separated out, which downstream
matching (`BashTool.preparePermissionMatcher`, `BashTool.tsx:445-468`) uses to match each *subcommand* of a
compound command (`ls && git push`) against permission patterns individually — so a rule scoped to `git *`
fires even if `git` is the second half of a compound command. Read-only classification itself
(`readOnlyValidation.ts:1876-1943`, `checkReadOnlyConstraints`) layers further semantic checks on top of
parsing: e.g. it explicitly blocks `cd`+`git` compound commands because a malicious directory can carry fake
git hooks (`readOnlyValidation.ts:1914-1923`), and blocks git entirely when the cwd looks like a hijacked
bare repo (`readOnlyValidation.ts:1925-...`). Per-command flag validation (`safeFlags` / `CommandConfig` per
command, `readOnlyValidation.ts:34-42` and the `GIT_READ_ONLY_COMMANDS` / `RIPGREP_READ_ONLY_COMMANDS`
tables) means a command is judged safe only if *every flag it uses* is on that command's own safe-flag list,
not just by matching the command name.

**Elowen.** `toolPermissions.ts` matches **glob patterns against the raw command string**, with a hand-rolled
quote-aware segmenter (`scanDoubleQuoted`, `toolPermissions.ts:413-421`) that splits on `;`/`&&`/`||`/`|`
outside quotes and blanks command substitutions (their own inner text is separately re-scanned as its own
segment — `toolPermissions.ts:413-415`). `segmentMatchValues` (`toolPermissions.ts:500-508`) strips leading
`VAR=` assignments and known wrapper commands (`env`, etc.) before matching, iteratively, to catch
`env FOO=1 rm`. There is no general-purpose grammar-level parser and no per-flag validation table — safety
instead comes from a **maintained deny/allow/clawback list** of literal glob patterns
(`NON_DESTRUCTIVE_BASH_ALLOW`, `EXEC_ESCAPE_DENY`, `NON_DESTRUCTIVE_BASH_CLAWBACKS`,
`toolPermissions.ts:53-134`) that documents *by hand* the same kind of escape Claude Code catches
structurally. It works, and the code is candid about its own limits ("a guardrail, not a sandbox... a shell
has unbounded ways to spell the same act", `toolPermissions.ts:167-169`) — the same limitation Claude Code's
own comment states almost word-for-word (`ast.ts:15`, "This is NOT a sandbox").

**Live demonstration, observed while producing this report.** A `Bash` heredoc call containing this
document's own prose (which quotes patterns like `*GIT_PAGER=*` as documentation) was denied by Elowen's live
permission gate — the matcher scanned the literal heredoc *text* as if it were shell syntax and matched an
unrelated deny pattern inside a documentation string that was never going to execute anything. That is
exactly the class of false positive a real grammar-level parser (which would recognize the heredoc body as
inert data, not as commands to classify) does not produce.

**Gain.** A real tree-sitter grammar would close a class of parser-differential bugs a regex/quote-scanner
can't reach by construction — process substitution `<(...)`, arithmetic `$(( ))`, arrays, here-docs,
nested/escaped quoting edge cases, exotic operators — the false-positive above being a live instance of that
same class. Claude Code's own source is explicit that it *replaced* an earlier hand-rolled parser
(`bashSecurity.ts`, referenced as `_DEPRECATED` throughout — `bashPermissions.ts` imports
`bashCommandIsSafe_DEPRECATED`, `readOnlyValidation.ts:26`) with tree-sitter specifically because the
hand-rolled one kept producing parser differentials — the exact risk Elowen's current segmenter carries
today. The per-command flag-allowlist model (validate every flag actually used, not just the command name) is
the second, independent win: it is more precise than "deny the whole pattern if it contains a scary
substring" and would let Elowen safely widen its allow-list (e.g. `git log` with an arbitrary flag
combination) without hand-enumerating every dangerous flag as a separate clawback pattern.

**Cost/risk.** This is the highest-value, highest-cost item in this report. A tree-sitter-bash dependency plus
a full node-type allowlist and an argv-based matcher is a multi-week undertaking done right, and a *partial*
port (parse but keep the same glob rules) buys little — the value is specifically in fail-closed handling of
syntax the current segmenter doesn't understand, which requires the grammar, not a patch to the regex.

**Verdict: ADOPT, high priority** for the parser replacement (fail-closed AST parsing directly reduces the
"expensive and irreversible" risk this review was asked to weight most heavily), but scope it as its own
project: swap `toolPermissions.ts`'s segmenter for a tree-sitter-bash walk that returns real argv arrays,
keep the existing glob rule *tables* as the matching layer on top (they don't need to change, only what they
match against). **ADAPT, medium priority** separately for per-command flag-allowlist validation on the
highest-traffic allow-listed commands (`git`, `find`, `curl`) as a lower-cost incremental step that doesn't
require the full parser swap.

---

## 8. OS-level sandbox for shell execution — Claude Code has one, Elowen has none

**Claude Code.** `SandboxManager` / `shouldUseSandbox` (`tools/BashTool/shouldUseSandbox.ts`) can run a
command inside an OS-level restricted environment (referenced throughout as sandboxing that "auto-allow[s]
Bash if sandboxed" — `permissions.ts:1094-1097,1189-1194` — precisely *because* the sandbox, not the
permission rule, is what's containing the blast radius). This is a defense-in-depth layer *underneath* the
rule-based classification covered in finding 7: even if a command is misclassified as safe, a sandboxed
process can't reach outside its jail. `dangerouslyDisableSandbox` is a per-call opt-out the model must
explicitly request (`BashTool.tsx:242`), and user/dynamic config can exclude specific commands from
sandboxing (`shouldUseSandbox.ts:19-30`, "not a security bug to be able to bypass excludedCommands... the
sandbox permission system... is the actual security control").

**Elowen.** The terminal plugin runs commands via PI's local shell backend with **no sandboxing at all** —
confinement is only `cwd` (via `ctx.assertPathAllowed`, `plugins/terminal/index.mjs:1-6`) plus the
permission-rule pattern matching covered in finding 7.

> **Superseded (22 Aug 2026).** Where this document says terminal tools are owner-only, they are now
> handed out by GRANTING the `userGrantable` `terminal` plugin to an account (admins have it implicitly);
> the plugin no longer gates on the owner bit itself. The sandboxing analysis below is unaffected — a
> shell still reads any absolute path, which is exactly why the grant means granting the host.

The plugin's own header comment is explicit about the
resulting gap: "cwd guarding does NOT contain a shell that reads absolute paths outside the repo (e.g. the
prod config DB), so ALL terminal tools are OWNER-ONLY" (`plugins/terminal/index.mjs:4-6`) — i.e. Elowen's
current mitigation for "no sandbox" is "only the verified human owner can reach this tool at all," not a
technical containment boundary. A command approved by the pattern rules — including any hole in those rules,
per finding 7 — runs with the full privileges of the daemon's OS user.

**Gain.** This is the layer that would make finding 7's inevitable rule-matching gaps non-catastrophic: a
process-level jail (network/filesystem restriction) means a rule that lets through something it shouldn't
still can't do unbounded damage.

**Cost/risk.** High. Real OS sandboxing (Linux landlock/bubblewrap/seccomp, or a container boundary) is
a substantial platform-specific engineering project, and Elowen's daemon architecture (long-lived process,
plugin tools calling into the same Node process, git worktree operations that need real filesystem access)
would need a deliberate design for what's inside vs. outside the jail before implementation starts.

**Verdict: ADOPT, high priority (design first).** Given that today's containment is "only the owner may call
Bash at all" rather than any technical bound on what a permitted Bash call can do, this is the single
highest-leverage item in this review — but it should start as a scoped design doc (what needs real
fs/network access — worktree git operations, npm/build tooling — vs. what doesn't), not a direct port of
Claude Code's sandbox, since Elowen's daemon/plugin architecture differs enough that the boundary has to be
re-derived, not copied.

---

## 9. MCP tool namespacing — already matched

**Claude Code.** MCP tools are namespaced `mcp__<server>__<tool>` (`services/mcp/mcpStringUtils.ts:19-32`,
`buildMcpToolName`, lines 50-52), permission rules can target a whole server with `mcp__server__*`
(`permissions.ts:258-268`), and `getToolNameForPermissionCheck` (`mcpStringUtils.ts:60-67`) makes sure a rule
written against a builtin name (`Write`) never accidentally matches an MCP tool with a colliding display
name.

**Elowen.** `registerBridgedTool` (`plugins/mcp/index.mjs:135-147`) builds the exact same
`mcp__<server>__<tool>` name, with an explicit comment tying the prefix to the deferred-tool-loading contract
(`index.mjs:138-140`, referencing `deferralPolicy.ts`).

**Verdict: SKIP — already adopted**, convention-for-convention identical. Nothing to do.

---

## 10. Tool-result persistence and truncation — already adopted, credited in the code

**Claude Code.** `persistToolResult`/`getPersistenceThreshold` (`utils/toolResultStorage.ts:55-150`) spill a
tool result larger than a per-tool threshold (`maxResultSizeChars`, defaulting via
`DEFAULT_MAX_RESULT_SIZE_CHARS`) to disk, replacing it in the model-facing content with a wrapped preview +
file path (`buildLargeToolResultMessage`) the model can re-read with the Read tool.

**Elowen.** `toolResultClearing.ts` (`src/brain/session/toolResultClearing.ts:12-97`) implements essentially
the same mechanism — spill-to-disk-with-preview above `SPILL_MAX_RESULT_BYTES` (`= 50_000`, comment at line
53: "50 000 is Claude Code's DEFAULT_MAX_RESULT_SIZE_CHARS") plus `SPILL_PREVIEW_CHARS` (`= 2000`, "matches
Claude Code's preview budget," line 69) — and *additionally* a time-based clearing trigger for old,
already-seen results once the prompt cache has gone cold anyway (lines 12-41), which Claude Code's version
doesn't describe.

**Verdict: SKIP — already adopted, and extended.** This finding exists mainly to confirm the port was done
correctly (thresholds and preview size match) and to note Elowen went one step further with the idle/cache-
aware clearing trigger. No action.

---

## 11. Dynamic tool advertisement: native `defer_loading` API flag vs. Elowen's full active-set removal

**Claude Code.** A tool can be marked `shouldDefer`/not `alwaysLoad` (`Tool.ts:438-449`); at the API-call
boundary this becomes a `defer_loading: true` field on that tool's schema object sent to Anthropic
(`utils/api.ts:68-71,223-226` — `BetaToolWithExtras`, a beta-only field the code explicitly strips for
proxy gateways that reject unknown fields, `api.ts:232-238`). The tool's *schema entry itself stays present
and in the same position* in the `tools` array every turn; only the `defer_loading` flag changes when
`ToolSearchTool` activates it. `ToolSearchTool` (`tools/ToolSearchTool/ToolSearchTool.ts`) lets the model
query by keyword or `select:<name>` and activates matches for the next turn.

**Elowen.** `computeDeferredToolNames` (`src/brain/toolSearch/deferralPolicy.ts:71-79`) decides, above a
threshold of 10 deferrable (MCP-only) tools, which tool *names* to withhold; `applyToolVisibility`
(`src/brain/session/capabilities.ts:281-294`) then calls PI's `session.setActiveToolsByName(desired)` — the
deferred tool's schema is **entirely absent** from the active set, not present-but-flagged. The module's own
comment states the tradeoff plainly: withholding "trades a lighter prompt for (a) a broken prompt cache on
the turn the active set changes and (b) one round-trip of latency" (`deferralPolicy.ts:11-16`), which is
exactly why the threshold defaults to 10 and MCP-only — for Elowen's modest native toolset the trade would be
a net loss.

**Gain of the native `defer_loading` model.** If genuinely supported outside Anthropic's internal builds, a
`defer_loading` flag that keeps the schema's position stable across activation would avoid the "changing the
active set busts the prefix" cost Elowen's own comment calls out — activation would only flip a flag, not
reshape the array. This directly touches the project's prompt-cache cost sensitivity.

**Cost/risk.** Unverified availability: `defer_loading` is called out in Claude Code's own source as a beta
API field that proxy/gateway providers reject (`api.ts:232-238`); there's no public confirmation it's
available on the standard Anthropic API outside Claude Code's own API access. Building against an
unconfirmed beta field risks building something that can't ship.

**Verdict: ADAPT, low priority, contingent.** Worth a short spike to check whether `defer_loading` is
actually available on Elowen's Anthropic API surface before committing engineering time; if it is, swapping
the removal-based deferral for a flag-based one would reduce the exact cache-invalidation cost Elowen already
identified and is trying to minimize with its threshold-of-10 heuristic. If it's Anthropic-internal-only,
this is a hard SKIP and Elowen's current design (accept the cache cost, but only past a threshold where the
prompt-weight savings outweigh it) is already the right tradeoff.

---

## 12. Plan-mode / read-only sub-agent tool clamp — different mechanism, Elowen's arguably stronger

**Claude Code.** Plan mode is a `ToolPermissionContext.mode` value (`'plan'`) that behaves like `'default'`
in the general permission pipeline unless the session originally started in `bypassPermissions`
(`isBypassPermissionsModeAvailable`, `permissions.ts:1268-1271`) — i.e. a write tool in plan mode is not
structurally withheld from the model, it still goes through the normal ask/allow decision, just with the
model expected (via system prompt / `EnterPlanModeTool`/`ExitPlanModeV2Tool`, which do declare
`isReadOnly()` — `EnterPlanModeTool.ts:71`, `ExitPlanModeV2Tool.ts:182`) to stick to read tools.

**Elowen.** Plan mode structurally **withholds** `Write`/`Edit` from what the model can even call, clamped to
one specific path (the session's own plan file) via `planWriteDenial`
(`src/brain/session/capabilities.ts:130-153`) — checked unconditionally, before the general permission gate
even runs, specifically so it can't be silently bypassed by a turn that happens to carry no permission scope
(comment at `capabilities.ts:138-141`). Separately, `buildReadOnlyBoundary`
(`src/brain/agents/readOnlyBoundary.ts:23-51`) mints a genuinely narrower permission boundary for read-only
sub-agents — parent rules, then a hard `Write`/`Edit` deny plus the non-destructive Bash clamp, then the
parent's own deny rules re-asserted last so the boundary can only ever narrow — with `unattendedAsks: 'deny'`
so an unattended read-only agent can never have an inherited `ask` silently resolve to allow.

**Verdict: SKIP — Elowen's approach is stronger for the case that matters most (unattended sub-agents).**
Claude Code's plan mode leans on the model's own discipline plus a permission prompt a human is expected to
be watching; Elowen's read-only sub-agent boundary is enforced structurally and fails closed
(`unattendedAsks: 'deny'`) precisely for the unattended case where nobody is watching. Nothing to adopt here.

---

## Summary table (ordered by value-for-effort)

| # | Finding | Verdict | Priority | Why |
|---|---|---|---|---|
| 7 | Tree-sitter AST bash parsing (fail-closed) + per-flag command validation | **ADOPT** (parser) / **ADAPT** (flags) | High | Directly hardens shell safety; current hand-rolled segmenter carries the same parser-differential risk Claude Code moved away from — and produced a live false positive while this report was being written |
| 8 | OS-level sandbox for shell execution | **ADOPT** (design first) | High | Today's containment is "owner-only access," not a technical bound on what a permitted command can do |
| 5 | Hook input-rewriting on `tools.call.before` | **ADAPT** | Medium | Small, contained addition to an existing mechanism; explicitly do NOT externalize hooks into user-configurable shell commands (new supply-chain risk) |
| 11 | Native `defer_loading` API flag instead of active-set removal | **ADAPT** (spike first) | Low–Medium | Would reduce prompt-cache churn Elowen already identified, but availability outside Claude Code's own API access is unconfirmed |
| 1 | Per-input `isReadOnly`/`isConcurrencySafe`/`isDestructive` tool metadata | **ADAPT** | Low | Real gap only for input-dependent (e.g. MCP) tools; native tools already covered by name/pattern allow-lists |
| 2 | Two-tier tool description (`promptSnippet`) | **SKIP** | — | Mechanism exists in PI unused, but doesn't address the cost that matters (cached `tools` schema) |
| 3 | Staged bypass-immune permission pipeline | **SKIP** | — | Elowen's simpler "deny always wins, no mode overrides deny" already gives the same guarantee without CC's carve-outs |
| 4 | LLM classifier for auto/YOLO mode + denial-limit breaker | **SKIP** | — | Recurring per-action inference cost conflicts with stated cost sensitivity |
| 6 | File-edit stale-write guard (mtime+fallback vs. content hash) | **SKIP — Elowen already better** | — | SHA-256 comparison is strictly more correct than mtime+content-fallback |
| 9 | MCP tool namespacing (`mcp__server__tool`) | **SKIP — already adopted** | — | Identical convention already in place |
| 10 | Tool-result disk-spill + preview truncation | **SKIP — already adopted** | — | Thresholds explicitly match Claude Code's; Elowen extended it with an idle/cache-aware trigger |
| 12 | Plan-mode / read-only sub-agent tool clamp | **SKIP — Elowen already better** | — | Structural withholding + fail-closed unattended default beats CC's ask-based plan mode for the unattended case |

---

*Note: the Elowen-side claims in this document were produced by a research agent reading the source; they
have not been independently re-verified line by line. Treat `path:line` references as starting points, not
as established fact.*
