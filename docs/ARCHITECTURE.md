# Architecture

This document describes the current Elowen daemon for contributors and operators. The executable source is under `src/`; the public user manual is under [`docs/site/`](site/).

## System shape

Elowen is a self-hosted TypeScript service with four cooperating parts:

- **Daemon** — the Hono HTTP API, the embedded brain, platform adapters, plugin services, persistence, recovery, and maintenance loops.
- **Web application** — the Next.js UI. Browser requests use the same-origin `/api` proxy; the daemon token is not exposed to browser JavaScript.
- **CLI/TUI** — `elowen chat`, `elowen run`, and `elowen api` talk to the daemon. `elowen setup`, `install`, `up`, `down`, `status`, and `update` manage the installation.
- **Optional delegated runner processes** — forked Node processes used for delegated turns when `runtime.subagentRunnerEnabled` is enabled. They reuse the same brain construction path but do not start the daemon, HTTP server, platform gateways, migrations, or scheduler.

The daemon listens on `127.0.0.1:4400` by default. The web server normally listens on `:4500`. Runtime state is outside the package, under `~/.config/elowen` by default; `ELOWEN_DB` and `ELOWEN_LOG_DIR` can override the database and log locations.

## Process construction

`src/daemon/brainCore.ts` exports `buildBrainCore()`, the single construction path for the brain and its stores. It creates and wires:

- `ConfigStore`, `UserStore`, project and per-account stores;
- the SQLite-backed `BrainStore`, event store, memory stores, usage attribution, and plugin secret vault;
- model credentials and the `ModelRuntime`;
- prompt services, memory recall/curation, Git readers, and path policy;
- the plugin registry and its live host controls;
- the `BrainService`, which owns session lifecycle, turns, channels, goals, processes, queueing, and delegation.

`src/daemon/bootstrap.ts` calls that factory, then adds daemon-only layers:

- the Hono API and authentication middleware;
- platform startup and outbound delivery;
- plugin service and interval runners;
- the delegated runner pool;
- push notifications, terminal cleanup, shutdown handling, recovery, and maintenance.

The forked runner also calls `buildBrainCore()`. This is intentional: tools, prompts, model routing, limits, and policy composition must remain byte-identical between in-process and out-of-process delegated turns. The runner does not construct another runner pool.

## Request and turn flow

For an authenticated owner-chat request, the main path is:

1. The API, CLI, or web client sends a request to the brain service.
2. Authentication, account ownership, project tenancy, and request shape are checked at the API boundary.
3. `ConversationLifecycle` resolves or creates the conversation and serializes admission for that session.
4. `LiveSessionSpawner` composes the model, system prompt, account instructions, skills, tools, project working directory, memory hooks, and provider settings.
5. `composeSessionTools()` applies session-kind composition, per-account tool authority, plan-mode restrictions, and execute-time permission gates.
6. The PI `AgentSession` runs the provider/tool loop. Tool calls and provider events are streamed to clients through `/brain/stream`.
7. `src/brain/persistence.ts` projects user input and generated messages into SQLite. SQLite is authoritative; the PI session is an in-memory execution object that can be rehydrated.
8. Usage, activity, memory curation, cards, delegated results, and notifications are settled after the turn.

The API route families are registered in `src/api/routes/index.ts`. Important core families are authentication, users, projects, activity, brain, configuration, usage, memory, plugins, hooks, and plugin UI/API dispatch.

## Conversations and persistence

`brain_sessions` is the durable conversation index. A row records the account anchor, title, model/provider pair, working directory, platform/direct-chat markers, parent delegation relationship, and recovery state.

`brain_messages` contains the durable transcript. The live PI session is not a second durable database and Elowen does not rely on JSONL files for conversation history. During startup or LRU eviction, the session is rebuilt from SQLite.

A delegated child is an ordinary brain session with a `parent_session_id` and a validated `delegated_access` JSON boundary. A forked conversation records provenance separately and is not treated as a delegated child.

Persistence is incremental during a turn:

- the clean user prompt is projected before provider execution;
- assistant and tool-result messages are mirrored while they finish;
- `agent_end` reconciles the final ordering and settles the turn;
- an interrupted partial turn is trimmed to the last prefix whose tool calls are all answered.

This prevents a restart from silently losing a long-running turn and prevents an unanswered tool call from being replayed as if its side effect were known to be safe.

## Session kinds and channels

Tool composition distinguishes three session kinds in `src/brain/session/capabilities.ts`:

- **`owner-chat`** — the authenticated operator's own chat and operator-authored automation. It is the only kind that receives owner-only `Elowen*` control tools and an owner API token.
- **`trusted-channel`** — a shared platform conversation whose sender has the operator's administrative role. It receives all-project policy and the full plugin toolset, but it remains a shared channel and never receives owner-only tools or the owner token.
- **`foreign-channel`** — a shared platform conversation driven by other role-scoped senders. Its tools remain policy-guarded and owner-only capabilities are withheld.

A platform direct message can be marked as a verified direct conversation, but it still uses the platform channel path. Shared rooms are never converted into owner chat merely because a sender is an administrator.

Platform turns use `ChannelSessionService` and the same spawner, memory, plugin context, and permission machinery as owner chat. The current writer is recorded separately from the session's account anchor. Unlinked shared-channel senders receive no personal memory.

## Accounts, tenancy, and access

The local `users` table is the account boundary. Accounts can be administrators or members and may be assigned to specific Projects through `user_projects`. Every route and tool that handles project data must preserve that tenancy boundary.

Authentication is bearer-token based at the daemon boundary:

```http
Authorization: Bearer <token>
```

The public exceptions include `/health`, `/setup`, login and SSO bootstrap routes, public theme assets, signed avatar requests, terminal tickets, and `/hooks/*`. Webhooks are intentionally public to the daemon middleware; the receiving plugin authenticates its provider-specific webhook token or assertion.

Before the first account exists, the daemon is in setup mode and requests are open so onboarding can create the first administrator. Once an account exists, ordinary requests require authentication. Query-string bearer tokens are not accepted.

Access has several independent layers:

1. **Account and role** — who is making the request and whether the account is an administrator.
2. **Project policy** — which registered Project roots the account may access.
3. **Plugin grants** — `userGrantable` plugins are deny-by-default for non-administrators until an administrator grants them.
4. **Tool authority** — the account's tool allow-list and disabled-tool list.
5. **Per-call permission rules** — ordered allow/ask/deny rules for tool names and shell commands.
6. **Execution identity** — personal tools, memory, secrets, and Sandbox workspaces are re-checked for the acting account at execution time.

The shared plugin predicate is `src/shared/pluginAccess.ts:isPluginAllowedForUser()`. Tool authority is resolved by `toolAuthorityForUser()` in `src/brain/brainDeps.ts` and enforced by the session tool wrappers. A visibility decision is not the security boundary: tools are checked again when they execute.

## Projects, paths, and Sandbox workspaces

A core Project is a registered filesystem root with a stable numeric ID and immutable slug. Core owns Project registration, account assignments, notes/icons, and the read-only Git snapshot exposed by `/projects/:id/git`.

File, terminal, editor, GitHub, and other integrations must use the shared project/path policy. `src/plugins/pathGuard.ts` resolves and validates paths rather than allowing each integration to invent a root.

The bundled `sandbox` plugin adds account-owned worktree roots to that same policy. Core consumes the plugin's typed `SandboxControl` live on every use; it does not read Sandbox tables directly. An active workspace can provide a branch, base reference, label, and path for a Project. Terminal and delegated execution receive a prepared launch with its working directory, HOME, roots, confinement mode, and a durable execution lease.

A read-only shell or plan-mode restriction is a policy guard, not a complete operating-system sandbox. The Sandbox plugin is the component that prepares confined execution where the configured runtime supports it.

## Brain tools and prompt composition

Core tools live in `src/brain/tools/`. Plugin tools are registered through `PluginContext` and must also be declared in the plugin manifest. `composeSessionTools()` builds the complete ordered set, then applies:

- optional deferred loading through `ToolSearch`;
- personal-tool ownership checks;
- account/plugin tool policy;
- plan-mode execute restrictions;
- granular allow/ask/deny permission rules;
- argument cleanup before the underlying handler runs.

Plan mode keeps the tool list stable for prompt-cache reasons. Mutating calls are refused at execution time, while `Write` and `Edit` are clamped to the current conversation's plan file. Do not treat the advertised tool list as sufficient enforcement.

Prompt inputs have distinct lifetimes:

- stable system and tool content is composed at spawn time;
- per-turn reminders and permissions are injected as volatile context;
- account instructions are escaped prompt data;
- plugin and delegated-role appendices are bounded before persistence;
- Project instruction files such as `AGENTS.md` and `CLAUDE.md` are loaded only for owner chat.

## Plugins and live reloads

Plugins are discovered from the bundled plugin directory and the instance data directory. The loader:

1. scans and validates `elowen-plugin.json`;
2. loads enabled plugins in deterministic name order;
3. stages each `register(ctx)` call in an isolated registry;
4. merges a plugin only after registration succeeds;
5. starts plugin services and boot reconciles in the daemon process.

A failed plugin is skipped without publishing partial tools or routes. The current bundled set is:

```text
askuser  elowen-docs  files  mcp  runtime-context
sandbox  statusline  subagent  terminal  web
```

The curated external registry supplies optional plugins such as codebase indexing, scheduling, skills, GitHub, platform adapters, LSP, editor, and other integrations. Retired domain plugins are not restored by core configuration.

A plugin owns its vertical slice: its data, routes, tools, browser pages, prompts, and lifecycle. Core reaches plugin-owned domains through declared controls and narrow host contracts. Consumers resolve controls at call time; retaining a control instance across a plugin reload is invalid.

Plugin browser pages mount under `/p/<plugin>/...`. Authenticated plugin APIs normally mount under `/plugins/<name>/api/*`; an explicitly declared root mount is a fallback and is registered after core routes. Core routes win on conflicts.

A reload closes new-work admission, drains active work within a bounded window, builds a new registry generation, and swaps it. Requests made from a running turn are deferred until that turn settles. Marketplace installation and update are staged atomically and retain rollback state until the new generation is verified.

Per-account plugin configuration is stored in `user_plugin_config` and declared by `userConfigSchema`. Plugins read the current account's values through `ctx.userConfig()`. Secret fields are write-only at the API surface; encrypted instance and account secrets use the plugin secret vault through `ctx.instanceSecrets()` and `ctx.userSecrets()`.

## Delegation and workflows

The `subagent` plugin exposes typed delegation and workflow tools. A delegated child is a durable conversation, not an unrestricted copy of the parent:

- its `DelegatedExecutionScope` captures administrator/project/owner authority, plugin tool policy, non-interactive permission rules, prompt appendices, read-only origin, spawning principal, and contribution account;
- the scope is normalized and validated before persistence and on every resume;
- a child can inherit or narrow the parent's authority, never widen it;
- `DelegateContinue` reuses the child transcript and re-checks the parent's current authority;
- `write_access: true` can only promote a read-only child explicitly requested as read-only, by the same spawning principal, and only to the caller's current authority;
- workflow nodes inherit the effective boundary of the creating node.

Workflow DAG execution is implemented by `plugins/subagent/lib/workflow.mjs`. The host-side reverse seam for dynamic node expansion is `WorkflowAddNodes`; a forked runner reaches it through host RPC and cannot fabricate its own identity.

Delegated state is durable in `brain_subagent_runs` and related session rows. Boot recovery is coordinated by `brain/recovery/coordinator.ts`: interrupted work is claimed before platforms start, then resumed in dependency order. Unanswered tool calls are not blindly replayed; they become a visible recovery-required state. Restart recovery is bounded and preserves durable results for later delivery.

The forked runner is enabled by default in fresh configuration (`runtime.subagentRunnerEnabled: true`) and sizes its pool automatically unless `runtime.subagentRunnerPoolMax` is set. A source-only checkout without compiled runner JavaScript falls back to in-process execution. After rebuilding a live installation, restart the daemon before expecting the runner build ID to match again.

## Goals, memory, and automation

A persistent goal is owned by a conversation and is driven by `GoalLoopService`. It re-enters the ordinary brain pipeline with the same account, Project, plugin, tool, and permission boundaries. It is not a separate mission or task executor.

Memory is per account. Recall and curation run through the core memory services and honor the acting identity in owner chat and verified platform turns. Uncategorized memories are never recalled. Embeddings and categorization are optional enhancements; keyword-based operation remains possible without an embedding model.

Scheduling is plugin-owned. Personal jobs run with the owning account and re-check account/plugin access when they fire; instance jobs are operator-owned. A scheduled platform delivery remains a channel turn, not an owner-chat turn.

## Database, migrations, and maintenance

SQLite is opened by `src/store/db.ts` with WAL mode, `synchronous = NORMAL`, and foreign keys enabled. Core schema is in `src/store/schema.sql`; additive and versioned migrations are applied from `db.ts`. Plugin-owned tables and migrations run through the plugin database capability.

Persistent state includes:

- configuration and accounts;
- Project assignments and external identities;
- plugin configuration and encrypted secrets;
- brain sessions, messages, pending messages, delegated runs, and recovery envelopes;
- memories, categories, embeddings, and usage events;
- activity events, usage-origin rollups, push subscriptions, and navigation settings.

`src/daemon/maintenance.ts` starts recurring cleanup and recovery work. It handles token, event, origin, session, attachment, terminal, idle-session, embedding, and memory-retention sweeps. Plugin services own their domain-specific reconciles and intervals. The boot recovery coordinator claims interrupted delegations and parked conversations before platform traffic can act on stale state.

## Where to start

| Concern | Primary code |
| --- | --- |
| Brain construction and dependency wiring | `src/daemon/brainCore.ts`, `src/daemon/bootstrap.ts` |
| Session lifecycle and turn admission | `src/brain/service/lifecycle.ts`, `src/brain/service/turnRunner.ts` |
| Prompt and tool composition | `src/brain/service/spawner.ts`, `src/brain/service/turnContextBuilder.ts`, `src/brain/session/capabilities.ts` |
| Persistence and rehydration | `src/brain/persistence.ts`, `src/store/brainStore.ts`, `src/brain/session/factory.ts` |
| Accounts, tenancy, and API auth | `src/api/auth.ts`, `src/api/middleware.ts`, `src/api/context.ts`, `src/store/userStore.ts` |
| Plugin loading and reload | `src/plugins/loader.ts`, `src/plugins/registry.ts`, `src/plugins/serviceRunner.ts` |
| Plugin access and secrets | `src/shared/pluginAccess.ts`, `src/plugins/pathGuard.ts`, `src/store/userPluginConfigStore.ts` |
| Delegation and recovery | `src/subagent/`, `src/brain/delegatedTurn.ts`, `src/brain/service/delegatedSession.ts`, `src/brain/recovery/` |
| Project and Sandbox path policy | `src/store/projectStore.ts`, `src/brain/service/workDir.ts`, `src/plugins/api.ts` |
| HTTP route registration | `src/api/routes/index.ts`, `src/api/routes/` |
| CLI and terminal UI | `src/cli/`, `src/tmux/` |

For implementation conventions and verification commands, see [`DEVELOPMENT.md`](DEVELOPMENT.md), [`GUIDES.md`](GUIDES.md), [`PLUGIN_DEV.md`](PLUGIN_DEV.md), and [`TESTING.md`](TESTING.md).
