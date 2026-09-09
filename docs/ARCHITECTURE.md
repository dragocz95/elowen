# Architecture

This document describes the current Elowen daemon for contributors and operators. The executable source is under `src/`; the public user manual is under [`docs/site/`](site/).

## System shape

Elowen is a self-hosted TypeScript service with four cooperating parts:

- **Daemon** — the authoritative runtime: Hono HTTP API, brain/session execution, SQLite access, plugin registry generation, platform orchestration, recovery, maintenance, and outbound transports.
- **Web application** — the Next.js presentation layer. It renders host and plugin pages and exposes a same-origin `/api` BFF to the browser; daemon credentials are not exposed to browser JavaScript. It does not own conversations, plugin state, identity, or authorization.
- **CLI/TUI** — `elowen chat`, `elowen run`, and `elowen api` talk to the daemon. `elowen setup`, `install`, `up`, `down`, `status`, and `update` manage the installation.
- **Optional delegated runner processes** — forked Node processes used for delegated turns when `runtime.subagentRunnerEnabled` is enabled. They reuse the same brain construction path and plugin registry, but do not start the daemon HTTP server, ordinary platform gateways, migrations, scheduler, or maintenance loops.

The daemon listens on `127.0.0.1:4400` by default. The web server normally listens on `:4500`. Runtime state is outside the package, under `~/.config/elowen` by default; `ELOWEN_DB` and `ELOWEN_LOG_DIR` can override the database and log locations. The package contains infrastructure plugins, not product-domain ownership: optional domain and integration verticals are installed from the curated plugin registry and remain owned by those plugins.

## Process construction

`src/daemon/brainCore.ts` exports `buildBrainCore()`, the single construction path for the brain, host stores, and plugin registry. It is shared by the daemon and delegated runner so both execute the same prompt, tool, model, and policy composition. It creates and wires:

- host stores such as `ConfigStore`, `UserStore`, `ProjectStore`, `UserProjectStore`, user settings, prompts, push subscriptions, and per-account plugin configuration;
- the SQLite-backed `BrainStore` facade and its focused stores for events, usage, delegation, memory, categories, dashboard digests, embeddings, and encrypted plugin secrets;
- model credentials and the `ModelRuntime`;
- prompt services, memory recall/curation, Git readers, and path policy;
- the live `PluginRegistryProvider`, including plugin contributions, routes, services, hooks, and typed controls;
- the `BrainService`, which owns session lifecycle, turns, channels, goals, processes, queueing, and delegation.

These are host capabilities, not hidden domain implementations. A plugin may use a declared, narrow store or control seam; core must not recreate a plugin's tables, routes, tools, or vertical workflow.

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
5. The identity resolver mints the turn's `TurnIdentity` from the authenticated account or verified platform sender. For shared rooms this is resolved again for each turn; the room's durable account anchor is never treated as the current writer.
6. `composeSessionTools()` applies session-kind composition, per-account tool authority, plan-mode restrictions, and execute-time permission gates.
7. The PI `AgentSession` runs the provider/tool loop. Tool calls and provider events are streamed to clients through `/brain/stream`.
8. `src/brain/persistence.ts` projects user input and generated messages into SQLite. SQLite is authoritative; the PI session is an in-memory execution object that can be rehydrated.
9. Usage, activity, memory curation, cards, delegated results, and notifications are settled after the turn.

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

The public exceptions include `/health`, `/setup`, login and SSO bootstrap routes, public theme assets, signed avatar requests, and `/hooks/*`. Webhooks are intentionally public to the daemon middleware; the receiving plugin authenticates its provider-specific webhook token or assertion.

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

A read-only shell or plan-mode restriction is a policy guard, not a complete operating-system sandbox. The Sandbox plugin is the component that prepares confined execution where the configured runtime supports it. Workspace branches use `elowen/u<account>/<slugified-label>` and add `-2`, `-3`, and so on only after a directory, branch, or stored-workspace collision.

A Project's execution target is declared in the shared wire contract as host or managed, and the Project DTO carries an `executionKind`. A managed target always names its stable registry identity; the target is never inferred from a filesystem path. A managed Project runs in its own rootless Podman container that survives across turns, with a workspace volume at `/workspace`, a home volume, and a data volume at `/data`; each execution runs inside as a transient systemd unit, and networking is either shared with the host with loopback denied or none. Container specs are frozen and host-derived, and a caller-authored mount list is explicitly not an execution capability. The Sandbox control's environment half covers provisioning, start, stop, restart, delete, snapshot, restore, limits, logs, guest file operations including chunked writes, managed worktrees, and preview bindings. Files, shell, browser, editor, LSP, MCP, and codebase surfaces reach a managed project through that control instead of the host filesystem, and on a managed project even tool-result spill files are written into the guest and named by a guest path. `prepareExecution` takes a closed set of lease kinds and offers no way to request unconfined execution.

## Brain tools and prompt composition

Core tools live in `src/brain/tools/`. Plugin tools are registered through `PluginContext` and must also be declared in the plugin manifest. `composeSessionTools()` builds the complete ordered set, then applies:

- optional deferred loading through `ToolSearch`;
- personal-tool ownership checks;
- account/plugin tool policy;
- plan-mode execute restrictions;
- granular allow/ask/deny permission rules;
- argument cleanup before the underlying handler runs.

Deferral is policy-driven, not a per-call choice. A deferred tool is registered and callable, but the prompt's deferred-tools block advertises it by name only and withholds its parameter schema until the model fetches it through `ToolSearch`. The awareness block is stable for the life of a session, which keeps it prompt-cache friendly, and is capped at 200 lines. `src/brain/toolSearch/deferralPolicy.ts` resolves each candidate's mode in strict precedence: the global switch, a never-defer set covering the core interaction path, plan-safe tools, a per-tool override, a per-source override, a source default, an MCP count threshold that defaults to 10, and immediate. Ranking in `src/brain/toolSearch/toolSearchTool.ts` combines keyword scoring with an optional semantic pass over a shared vector index, weighted so a strong semantic match outranks a description-word hit but never a name hit; it needs an embedding model, and any semantic failure degrades to keyword-only ranking. Candidates are filtered by policy before ranking, so a forbidden high-scoring tool cannot consume the result budget. Skills ride the same ranking batch and are returned as a pointer naming `SkillLoad`, at most three, rather than being activated.

When the provider offers native hosted tool search, `src/brain/session/hostedToolSearch.ts` resolves that route subtractively: the global deferral switch, an off-only per-provider override, a provider and model family gate, and, for Azure, a stored probe fingerprint. Nothing in the resolution can grant a route that was not probed, which is why the per-provider field's only permitted value is `false`; a session without a resolved route uses local `ToolSearch`. `src/brain/session/anthropicHostedToolReplay.ts` is the compatibility shim for that route: the agent runtime does not preserve hosted-search content blocks across requests and Anthropic re-validates the latest assistant message, so Elowen captures those blocks from the response stream and restores them verbatim before the next request. Without it, a hosted-search turn between signed thinking blocks kills the conversation.

Plan mode keeps the tool list stable for prompt-cache reasons. Mutating calls are refused at execution time, while `Write` and `Edit` are clamped to the current conversation's plan file. Do not treat the advertised tool list as sufficient enforcement.

Prompt inputs have distinct lifetimes:

- stable system and tool content is composed at spawn time;
- per-turn reminders and permissions are injected as volatile context;
- account instructions are escaped prompt data;
- plugin and delegated-role appendices are bounded before persistence;
- Project instruction files such as `AGENTS.md` and `CLAUDE.md` are loaded only for owner chat.

## Context management

Elowen drives the embedded agent runtime's own compaction instead of reimplementing it, and adds three mechanisms around it. In-session compaction (`src/brain/session/inSessionCompaction.ts`) runs the summarization request on the session's own model against its warm prefix, instead of the runtime's standalone summarization, which re-serializes the conversation with caching disabled and a fresh session id. The module documents why: over one week, 40 compaction requests and 6.3 million input tokens read exactly zero cached tokens. It applies only when no separate compaction model is configured and the provider is not the ChatGPT account route. The runtime keeps full ownership of what the summary says; Elowen supplies only the stream function underneath it. A guard turns two bad responses into stream errors, a model that called a tool instead of summarizing and a model that returned no summary text, and every failure path falls back to the runtime's standalone summarization rather than failing the turn.

`src/brain/session/turnBoundaryCompaction.ts` installs the threshold check at the runtime's safe between-turn boundary, because the runtime natively evaluates only after the agent run ends, which is too late when one run contains many assistant and tool steps. `src/brain/session/coldStartCompaction.ts` adds the only automatic cold trigger, at the start of a turn, and only when the provider cache is provably cold, nothing is in flight, and a break-even calculation says compacting now costs less than re-sending the prefix. `src/brain/session/compactionModelRoute.ts` substitutes a configured compaction model only for stream calls carrying the runtime's compaction abort signal, stripping the chat provider's credentials when the fallback is a different provider. `src/brain/session/remoteCompactionV2.ts` replaces text summarization on a ChatGPT-account session with a provider-side compaction blob, falling back to text summarization on any failure.

`src/brain/session/compactionCircuitBreaker.ts` holds two independent guards, both bypassed by a manual `/compact`: a consecutive-failure counter, default 3 and operator-tunable, protecting against a context that cannot be summarized failing identically on every turn forever; and an unreachable-threshold guard that refuses a threshold compaction whose post-compaction floor would still exceed the trigger. Each is reported to the user once, with text naming the numbers and pointing at `/compact` or a new conversation.

Cold context trimming is a separate, mechanical mechanism that costs no provider request. `src/brain/session/coldToolResultClearing.ts` and `toolResultClearing.ts` replace old tool-result text with a placeholder once the provider cache is provably cold and no work is in flight. A result is eligible when it carries at least `COLD_CLEAR_MIN_BYTES` (1024) of text, carries a tool call id, and has not already been cleared, identified structurally rather than by a text prefix. The full output is written write-once to the session's spill directory under the data directory, and the placeholder names that path, so the model can read it back through the ordinary path guard; clearing or deleting the conversation removes it. `src/brain/session/runtimeFrames.ts` does the same for historical runtime framing: memory, permissions, plugin context, and one-shot reminders are composed into each user message and rebuilt from scratch every turn, so once the cache is cold the historical copies are replaced by a single marker. Nothing is spilled there, because every block is composed again from live state. The last user turn's framing, and what the user and the assistant actually said, are never touched.

The governing rule, stated in `toolResultClearing.ts`, is that history the provider could still have cached is never rewritten. There are exactly two safe moments, one trigger at each: at delivery, where nothing has been sent yet, and at the start of a cold turn. Neither cold clearing nor frame stripping shows anything in the transcript; they are log-only. Compaction does: a notice while it runs, and a stored `compaction` row that both clients render as a "context compacted" divider.

## Plugins and live reloads

Plugins are discovered from the bundled plugin directory and the instance data directory. The loader:

1. scans and validates `elowen-plugin.json`;
2. loads enabled plugins in deterministic name order;
3. stages each `register(ctx)` call in an isolated registry;
4. merges a plugin only after registration succeeds;
5. starts plugin services and boot reconciles in the daemon process.

A failed plugin is skipped without publishing partial tools or routes. The current bundled set is:

```text
askuser  changelog  elowen-docs  files  mcp  runtime-context
sandbox  statusline  subagent  terminal  web
```

Four of the bundled plugins ship browser bundle sources: `subagent`, `sandbox`, `mcp`, and `changelog`.

The curated external registry supplies optional plugins such as codebase indexing, scheduling, skills, GitHub, platform adapters, LSP, editor, and other integrations. Retired domain plugins are not restored by core configuration.

A plugin owns its vertical slice: its data, routes, tools, browser pages, prompts, services, migrations, and lifecycle. There are no core-owned product-domain plugins hidden behind daemon routes or stores; core owns only shared runtime and host infrastructure. Image generation and editing ride `ctx.images`, a host-owned seam: core owns both transports, the API-key endpoint's Images API and the ChatGPT account's image backend, and returns only the finished bytes and the provider's usage, so a plugin never holds the provider credential. Core reaches plugin-owned domains through declared, typed controls and narrow host contracts. A control is a live capability published by the current registry generation: consumers resolve it at call time, and retaining a control instance across a plugin reload is invalid. A missing owner or unmet control dependency resolves as unavailable rather than exposing a half-working seam.

Plugin browser pages mount under `/p/<plugin>/...`. Authenticated plugin APIs normally mount under `/plugins/<name>/api/*`; an explicitly declared root mount is a fallback and is registered after core routes. Core routes win on conflicts.

A reload closes new-work admission, drains active work within a bounded window, builds a new registry generation, and swaps it. Requests made from a running turn are deferred until that turn settles. Marketplace installation and update are staged atomically and retain rollback state until the new generation is verified.

Per-account plugin configuration is stored in `user_plugin_config` and declared by `userConfigSchema`. Plugins read the current account's values through `ctx.userConfig()`. Secret fields are write-only at the API surface; encrypted instance and account secrets use the plugin secret vault through `ctx.instanceSecrets()` and `ctx.userSecrets()`.

## Delegation and workflows

The `subagent` plugin exposes typed delegation and workflow tools. A delegated child is a durable conversation, not an unrestricted copy of the parent:

- its `DelegatedExecutionScope` captures administrator/project/owner authority, plugin tool policy, non-interactive permission rules, prompt appendices, read-only origin, spawning principal, and contribution account;
- the scope is normalized and validated before persistence and on every resume;
- a child can inherit or narrow the parent's authority, never widen it;
- the scope also records the reasoning level the child was spawned on, because continuation, eviction and boot recovery rebuild the child from the scope alone;
- `DelegateContinue` reuses the child transcript and re-checks the parent's current authority;
- `write_access: true` can only promote a read-only child explicitly requested as read-only, by the same spawning principal, and only to the caller's current authority;
- workflow nodes inherit the effective boundary of the creating node.

`Delegate` and a workflow node take an optional `thinkingLevel`. Omitted, the child inherits the delegating turn's reasoning effort, and the provider layer clamps a level the child's model cannot serve. Given explicitly, it is validated against that model's own ladder (`PluginModelOption.reasoningLevels`, assembled in `src/brain/models.ts`) and an unsupported value is refused with the levels that model does have, rather than clamped. A model the live catalog does not list is not evidence of anything, so the level is passed on and clamped instead of refused. The effective level travels on the sub-agent progress row and on the workflow node snapshot, so the CLI and the web show what each child actually runs on.

The level is not authority, so `sameDelegatedExecutionScope` ignores it. A child spawned before the field existed keeps running on the inherited default until it is spawned again; its stored scope is not upgraded by request input, and a rebuilt scope that carries a level must not fail the durable-scope check against a row that has none.

Workflow DAG execution is implemented by `plugins/subagent/lib/workflow.mjs`. The host-side reverse seam for dynamic node expansion is `WorkflowAddNodes`; a forked runner reaches it through host RPC and cannot fabricate its own identity.

Delegated state is durable in `brain_subagent_runs` and related session rows. Boot recovery is coordinated by `src/brain/recovery/coordinator.ts`: interrupted work is claimed before platforms start, then resumed in dependency order. Unanswered tool calls are not replayed; `settlePartialTurn()` answers each with a synthetic interrupted result (see "Database, migrations, and maintenance"). A child row that cannot be respawned is parked as `recovery_required` instead. Restart recovery is bounded and preserves durable results for later delivery.

The forked runner is enabled by default in fresh configuration (`runtime.subagentRunnerEnabled: true`) and sizes its pool automatically unless `runtime.subagentRunnerPoolMax` is set. A source-only checkout without compiled runner JavaScript falls back to in-process execution. After rebuilding a live installation, restart the daemon before expecting the runner build ID to match again.

## Goals, memory, and automation

A persistent goal is owned by a conversation and is driven by `GoalLoopService`. It re-enters the ordinary brain pipeline with the same account, Project, plugin, tool, and permission boundaries. It is not a separate mission or task executor.

Memory is account-owned by default. An administrator can configure a Project shared pool whose eligible members can recall and manage the pool's rows; owner chat and verified platform turns still honor the acting identity. Uncategorized memories are never recalled. Embeddings and categorization are optional enhancements; keyword-based operation remains possible without an embedding model.

Scheduling is plugin-owned. Personal jobs run with the owning account and re-check account/plugin access when they fire. Owner-chat and Web-created recurring jobs use a dedicated job conversation unless a permitted explicit notification channel is configured. Direct one-to-one platform jobs retain their direct origin, while shared-room jobs use the normal channel path. An explicit notification channel takes precedence over the normal ownership-based destination. Instance jobs are operator-owned. Filing a job under a conversation is organizational and does not change execution context, model, permissions, or delivery.

## Database, migrations, and maintenance

SQLite is opened by `src/store/db.ts` with WAL mode, `synchronous = NORMAL`, and foreign keys enabled. Core schema is in `src/store/schema.sql`; additive and versioned migrations are applied from `db.ts`. Plugin-owned tables and migrations run through the plugin database capability.

Persistent state includes:

- configuration and accounts;
- Project assignments and external identities;
- plugin configuration and encrypted secrets;
- brain sessions, messages, pending messages, delegated runs, and recovery envelopes;
- memories, categories, embeddings, and usage events;
- activity events, usage-origin rollups, push subscriptions, and navigation settings.

`src/daemon/maintenance.ts` starts recurring cleanup and recovery work. It handles token, event, origin, session, attachment, idle-session, embedding, and memory-retention sweeps. Plugin services own their domain-specific reconciles and intervals.

Shutdown is a bounded pause, not a drain, and it is the only shutdown: SIGTERM and SIGINT both trigger it (`src/daemon/shutdown.ts`). The daemon originally had no handler, and the first fix waited for the work, which became the problem: measured over 106 restarts, a restart with a sub-agent in flight took a median of four minutes to exit and one in five burned a ten-minute budget. A pause instead checkpoints and exits inside the supervisor's 30 second stop timeout, and a second signal exits immediately. `BrainService.pauseForRestart()` latches draining so new turns are refused and parked questions are cancelled, parks every live owner and platform turn, checkpoints the runtime's in-memory steer and follow-up queue into a side table rather than as transcript rows, and closes in-flight provider request rows. It deliberately issues no abort, because an abort would unwind through the delegation tree and terminalize the child runs a pause exists to keep. The one wait is a bounded 20 seconds for turns nothing can resume, such as a cron run or a turn from an unlinked sender, after which what still runs is recorded so the boot sweep can say so. A self-requested restart exits with a reserved status rather than running a service restart from inside the process being restarted.

An interrupted turn is settled by `settlePartialTurn()` in `src/brain/persistence.ts`. Every outstanding tool call gets a synthetic interrupted result whose text tells the model the call may or may not have taken effect and to verify before repeating it. A delegation call gets different text: the child resumes automatically, its result will arrive as a system message, and the model must not re-delegate. A child that already finished has its answer folded in, clipped, with a pointer to read the rest. A trailing assistant message that is not provably final is retired so the model regenerates that step, and it is the only row a resume rewrites.

Boot recovery is constructed in the daemon's own layer, which is what leaves the sub-agent runner with no coordinator rather than an empty one. Claims are taken synchronously before platforms start, so nothing connecting when the port opens can observe a phantom running delegation. Resumption runs afterwards, because every recovery turn rides the ordinary channel path. Providers resume in dependency waves, and the delegation claim is deliberately split from the respawns so the owner and platform sweeps depend on the cheap synchronous claim rather than queueing behind every respawn's whole turn. Delegations recover deepest-first. One provider's failure is isolated and never softened into success. A parent turn blocked only on delegations that this boot is recovering is not continued at boot: its continuation is the child's answer.

## Where to start

| Concern | Primary code |
| --- | --- |
| Brain construction and dependency wiring | `src/daemon/brainCore.ts`, `src/daemon/bootstrap.ts` |
| Session lifecycle and turn admission | `src/brain/service/lifecycle.ts`, `src/brain/service/turnRunner.ts` |
| Prompt and tool composition | `src/brain/service/spawner.ts`, `src/brain/service/turnContextBuilder.ts`, `src/brain/session/capabilities.ts` |
| Tool deferral and hosted tool search | `src/brain/toolSearch/` |
| Context management | `src/brain/session/inSessionCompaction.ts`, `src/brain/session/coldToolResultClearing.ts`, `src/brain/session/runtimeFrames.ts` |
| Persistence and rehydration | `src/brain/persistence.ts`, `src/store/brainStore.ts`, `src/brain/session/factory.ts` |
| Accounts, tenancy, and API auth | `src/api/auth.ts`, `src/api/middleware.ts`, `src/api/context.ts`, `src/store/userStore.ts` |
| Plugin loading and reload | `src/plugins/loader.ts`, `src/plugins/registry.ts`, `src/plugins/serviceRunner.ts` |
| Plugin access and secrets | `src/shared/pluginAccess.ts`, `src/plugins/pathGuard.ts`, `src/store/userPluginConfigStore.ts` |
| Delegation and recovery | `src/subagent/`, `src/brain/delegatedTurn.ts`, `src/brain/service/delegatedSession.ts`, `src/brain/recovery/` |
| Project and Sandbox path policy | `src/store/projectStore.ts`, `src/brain/service/workDir.ts`, `src/plugins/api.ts` |
| HTTP route registration | `src/api/routes/index.ts`, `src/api/routes/` |
| CLI and terminal UI | `src/cli/`, `src/tmux/` |

For implementation conventions and verification commands, see [`DEVELOPMENT.md`](DEVELOPMENT.md), [`GUIDES.md`](GUIDES.md), [`PLUGIN_DEV.md`](PLUGIN_DEV.md), and [`TESTING.md`](TESTING.md).
