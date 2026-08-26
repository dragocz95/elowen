# Guides

Collection of advanced architecture patterns, internal mechanisms, and integration knowledge.

## Persistent goals

A conversation can hold a durable goal with subgoals, a turn budget, and a hard ceiling. Goal execution uses the same account, Project, tool, permission, and plugin boundaries as an ordinary turn. It is not a separate task or mission database.

## Delegation and workflows

`Delegate` starts an isolated child conversation under a captured authorization boundary. The child may be read-only or inherit the caller's effective access, but it cannot widen that access. `DelegateContinue` resumes the same child transcript; workflow DAGs compose these children with explicit dependencies and per-node model choices.

Delegation state is durable in SQLite. Boot recovery claims interrupted runs through the recovery coordinator rather than blindly replaying unanswered tool calls.

## Permissions

Per-account tool authority has two layers:

- an explicit allow-list of tools the account may use;
- ordered allow/ask/deny rules for tool names and shell commands.

Interactive `ask` decisions park the turn until answered. Unattended turns use the captured non-interactive boundary and fail closed where a decision cannot be obtained.

## Project and path boundaries

Core Projects owns registration, tenancy, notes/icons, and read-only Git state. File, editor, terminal, sandbox, and integration plugins consume the same core Project access and path guards; they must not invent parallel roots or widen access when an owner is disabled.

The generic Git snapshot exposes sanitized remotes, branch/HEAD/upstream, ahead/behind, and dirty/untracked counts. Core does not publish branches, create worktrees, or own pull-request workflow.

## Encrypted plugin credentials

New plugin credentials use `ctx.instanceSecrets()` or `ctx.userSecrets()`. AES-256-GCM authenticates the scope, account, plugin, and key as associated data. A missing or mismatched master key with encrypted rows makes the vault unavailable and never generates a replacement; a single corrupt row is isolated so the owning integration can request reconnection.

Back up the SQLite database and `plugin-secrets.key` as one recovery unit.

## Plugin lifecycle

1. **Discovery** — scan bundled and instance plugin directories.
2. **Staging** — parse the manifest and register into an isolated registry.
3. **Merge** — publish the complete contribution only after registration succeeds.
4. **Services** — run boot reconciles, then start daemon-owned services and intervals.
5. **Reload** — drain live work, build a new registry generation, and swap it atomically.

Plugins with account or Project state register `registerUserRemoved()` and `registerProjectRemoved()` handlers. Because a disabled plugin misses live callbacks, it also reconciles durable rows against current core users/Projects when next enabled.

## Plugin controls

A control is a live domain contract one plugin exposes to core or another plugin. Consumers resolve it on every use through `ctx.control()`; they never cache a control across plugin reloads. Missing owners are an expected state and must produce an honest unavailable response, not a fabricated empty result.

## Plugin API and UI

Authenticated plugin routes live under `/plugins/<name>/api/*` unless the manifest explicitly declares a root mount. Core routes always win. Plugin browser pages mount under `/p/<plugin>/...` and share the host authentication, React Query runtime, localization, and design primitives.

See [Plugin Development](PLUGIN_DEV.md) for the complete manifest and runtime contracts.
