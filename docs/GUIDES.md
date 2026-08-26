# Guides

This page collects implementation patterns for contributors and operators working across Elowen's daemon, web client, CLI, plugins, Projects, and account policy. The executable source is authoritative; use [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full component map and [`PLUGIN_DEV.md`](PLUGIN_DEV.md) for manifest details.

## Start from the owning boundary

Keep behavior in the component that owns it:

- The daemon owns authentication, account tenancy, Projects, conversations, persistence, authorization, and the HTTP route families.
- The web application owns browser presentation, same-origin proxying, React Query state, and browser-only transports.
- The CLI owns terminal interaction, local preferences, local shell execution, and top-level lifecycle dispatch.
- A plugin owns its domain data, routes, tools, browser pages, configuration, secrets, and services.

Do not add a second source of truth in a consumer. For example, extend `src/shared/wireContract.ts` for a daemon/web transcript shape; do not hand-maintain a second wire type in the browser. Resolve plugin controls at use time with `ctx.control()` so a live plugin reload cannot leave a stale control captured in a long-lived closure.

## Request and turn path

An authenticated owner-chat request normally follows this path:

1. The API, CLI, or web client authenticates and validates the request.
2. Project ownership and account policy are checked at the boundary.
3. `ConversationLifecycle` admits the turn for its conversation and resolves the durable session.
4. `LiveSessionSpawner` composes the model, account instructions, skills, tools, working directory, memory hooks, and provider settings.
5. `composeSessionTools()` applies session kind, account tool authority, plan restrictions, and per-call permission rules.
6. The provider/tool loop streams events to `/brain/stream` and persists the transcript incrementally.
7. Usage, activity, memory curation, delegated results, and notifications settle after the turn.

SQLite is authoritative. A live provider session is an in-memory execution object that can be rebuilt from durable session and message rows after eviction or restart.

## Accounts, Projects, and execution identity

The `users` table is the account boundary. Administrators have instance-wide management access; member accounts are limited by their assigned Projects and account policy. A Project is a registered filesystem root with a stable numeric id and slug. Core Project behavior includes registration, notes/icons, assignments, and a read-only Git snapshot.

Every project-capable route and tool must use the shared path policy in `src/plugins/pathGuard.ts` and the current account's Project assignments. A UI visibility decision is not a security check: the route or tool must re-check the acting identity at execution time.

The account boundary also applies to personal memory, account plugin configuration, encrypted user secrets, GitHub credentials, Sandbox workspaces, and per-user tool authority. Shared channel senders are not silently treated as the account owner, and unlinked senders do not receive personal memory.

## Tool authority and permission rules

Tool access has separate layers:

1. account and administrator/member role;
2. assigned Project roots;
3. per-account plugin grants;
4. the account's positive tool allow-list and disabled-tool list;
5. ordered per-call `allow`, `ask`, and `deny` rules;
6. execution-time ownership and identity checks.

`toolAuthorityForUser()` in `src/brain/brainDeps.ts` is the shared resolver for owner chat, linked channel turns, delegated children, and workers. A new account starts without plugin tools until they are granted; administrators bypass the positive grant restriction, while explicit deny rules still apply. An unknown account resolves to an empty grant.

`gatePermissions()` in `src/brain/session/capabilities.ts` is the single per-call gate for built-in and plugin tools. Tool rules match tool names; shell rules match the command string. The last matching rule wins. An interactive `ask` parks the turn for approval. Unattended channel, scheduled, or delegated turns have no approval channel and follow the account's unattended-ask policy. A denial must remain a denial under `/yolo`.

Plan mode is a policy restriction, not a complete sandbox. The full tool list remains advertised for prompt-cache stability. Mutating tools are refused at execution time, and only `Write` and `Edit` may operate on the current conversation's plan file. Do not enforce plan mode only in a UI or only while composing the tool list.

## Delegation and workflow design

The `subagent` plugin exposes `Delegate`, `DelegateContinue`, status/result inspection, and workflow DAG operations. A child is a durable brain session with a validated `DelegatedExecutionScope`, not an unrestricted copy of its parent.

A safe delegation implementation must preserve these invariants:

- the child inherits or narrows the caller's authority and can never widen it;
- administrator, Project, owner, plugin-tool, prompt, and non-interactive permission boundaries are captured and validated;
- `DelegateContinue` re-checks current parent authority before resuming;
- a read-only child can be promoted only through the explicit `write_access` path by the same spawning principal and only to current caller authority;
- workflow nodes inherit the effective boundary of the node that creates them;
- forked runner processes use the same `buildBrainCore()` path but do not start another daemon, HTTP server, scheduler, or platform gateway.

Workflow nodes should be self-contained and report a bounded result. Independent nodes may run in parallel; dependency edges must be explicit and acyclic. Dynamic expansion goes through the host `WorkflowAddNodes` seam rather than allowing a child to fabricate workflow identity or bypass the host.

Delegated state is durable in `brain_subagent_runs` and related session rows. Recovery claims interrupted work in dependency order; unanswered tool calls are not replayed blindly as if their side effects were known.

## Goals and long-running work

A persistent goal belongs to a conversation and is driven by `GoalLoopService`. It re-enters the normal brain pipeline with the same account, Project, plugin, tool, and permission boundaries as an ordinary turn. A goal is not a separate executor or permission domain.

When adding or changing goal behavior, test pause, resume, budget exhaustion, blocked outcomes, cleanup, and restart recovery. Keep the goal's observable state in the durable conversation projection so the CLI and web client can converge after reconnect.

## Sandbox and GitHub handoff

The bundled `sandbox` plugin provides account-scoped execution state:

- persistent account HOME;
- Git worktree workspaces per Project;
- one active workspace per conversation and Project;
- durable process leases;
- explicit-path commits;
- clean/loss previews before workspace removal.

Non-operator commands are confined by default when the runtime supports the configured isolation. Network access remains available for package installation, Git, and development servers. If the live namespace probe cannot establish confinement, execution is refused rather than silently run unconfined.

The optional GitHub plugin keeps each account's GitHub identity and repository mapping separate. Its read operations cover repository status, pull requests, changed files, checks, and reviews. Publishing or merging is an external action: it requires a verified Project mapping, an active Sandbox workspace where required, a preview, and one-time explicit confirmation. The default merge method is `squash` unless the account's plugin configuration selects another supported method.

Core Projects does not create worktrees, publish branches, create pull requests, or merge them. Those operations belong to Sandbox and GitHub plugin contracts and must remain unavailable when their owning plugin is disabled.

## Plugin lifecycle and reloads

The plugin loader discovers manifests, validates them, stages registration in an isolated registry, and publishes a plugin only after registration succeeds. Services and boot reconciles start after the registry is complete. A failed plugin must not publish partial routes, tools, or UI.

Reloads close new-work admission, drain active work within a bounded window, construct a new registry generation, and swap it atomically. Long-lived code must not cache plugin controls or plugin-derived authorization decisions across that swap.

For plugin state cleanup, implement both live removal handlers and durable reconciliation. A disabled plugin misses live callbacks, so its next enable must reconcile rows against current users and Projects. Secret fields are write-only at API boundaries; use `ctx.instanceSecrets()` and `ctx.userSecrets()` rather than storing credentials in ordinary configuration.

## Adding an API-backed feature

1. Identify the owning route family and domain store.
2. Define and validate request/response shapes in `src/api/schemas/`.
3. Enforce authentication, account ownership, Project access, plugin grants, and execution-time policy in the route or tool.
4. Add the browser operation to `web/lib/elowenClient.ts`, then expose it through `web/lib/queries.ts` or `web/lib/mutations.ts`.
5. Reuse existing shell, overlay, form, state, and localization primitives.
6. If the feature streams state, use the existing SSE event and invalidation path instead of a second polling protocol.
7. Add the narrowest regression test that would have caught the failure.
8. Run the focused test, typecheck/lint, and the relevant build or end-to-end path.

For a cross-surface command, add it once to `src/brain/slashCommands.ts`. The daemon publishes the identity-filtered catalog at `GET /brain/commands`; CLI, web, and platform adapters must not maintain competing built-in name lists.

## Persistence, migrations, and recovery

Core SQLite setup and migrations are owned by `src/store/db.ts`; fresh schema is in `src/store/schema.sql`. Never edit a shipped migration in place. Add an idempotent additive migration and a matching fresh-schema change. Plugin tables and migrations belong to the plugin database capability.

Persist before relying on recovery. Conversation messages are projected while a turn runs; final settlement reconciles ordering, and an interrupted prefix is trimmed so an unanswered tool call is not replayed. For restart-sensitive work, preserve durable result and recovery states and make cleanup idempotent.

Back up the SQLite database and `plugin-secrets.key` together. An encrypted secret vault with a missing or mismatched master key must remain unavailable rather than generating a replacement key; a corrupt row should be isolated to the owning integration so reconnection is possible.

## Operational verification checklist

Before handing off a change, verify the affected boundary rather than only the happy-path component:

- account and Project ownership, including a member and an unknown/deleted account;
- plugin disabled, unavailable, incompatible, and reload states;
- interactive approval and unattended ask behavior;
- restart, reconnect, cancellation, and duplicate-delivery behavior for streams or delegated work;
- path traversal and workspace cleanup conditions;
- external-action preview/confirmation and state-change races;
- browser keyboard, focus, responsive, loading, and error states where applicable.

Use [`DEVELOPMENT.md`](DEVELOPMENT.md) for repository commands, [`SECURITY.md`](SECURITY.md) for the security model, [`TESTING.md`](TESTING.md) for the verification matrix, and [`WEB.md`](WEB.md)/[`CLI.md`](CLI.md) for client-specific contracts.
