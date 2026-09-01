# Concepts

Elowen is easiest to operate when its durable objects and authority boundaries are kept distinct. This page is a mental model for the current system; it intentionally does not describe the retired missions, coding-agent worker, Pilot, or pull-request verticals.

## Instance

An **instance** is one Elowen installation and its daemon state. The daemon is the authority for the runtime and owns:

- one SQLite database and its host stores;
- one configuration and live plugin-registry generation;
- one operator authority boundary;
- one set of registered Projects;
- optional platform adapters and external integrations.

The Next.js web process is a client-facing presentation/BFF layer, not a second owner of brain state or permissions. Product-domain capabilities are plugin-owned; core supplies shared runtime, tenancy, identity, persistence, and host seams rather than embedding domain plugins.

The default state directory is `~/.config/elowen`. The database is `~/.config/elowen/elowen.db`, logs are under `~/.config/elowen/logs`, and `ELOWEN_DB` / `ELOWEN_LOG_DIR` override those locations.

The daemon is normally available at `http://localhost:4400`; the web UI normally uses port `4500`. `GET /health` is the quickest process-level check. `elowen doctor` performs a broader readiness check without starting a missing daemon.

## Accounts and operator authority

An **account** is a row in the local `users` table. An account may be an administrator and may be assigned to one or more Projects. Account settings include model preferences, instructions, memory toggles, tool policy, plugin grants, and personal integration configuration.

The **operator** is the instance-level authority used for actions that affect the installation itself. `operatesInstance()` is the shared predicate for instance MCP servers, raw platform APIs, host-path publishing, and other instance-scoped operations. A moderator role in a shared chat is not automatically the operator.

Normal API authentication uses:

```http
Authorization: Bearer <token>
```

The web UI keeps authentication in its same-origin session path. The CLI sends a bearer token directly. Before the first account is created, the daemon is temporarily open for onboarding; authentication resumes automatically afterwards.

## Projects and effective workspaces

A **Project** is a registered filesystem root with a stable slug and numeric ID. Projects are the primary tenancy boundary: account assignments, file access, Git snapshots, uploads, and most plugin operations resolve through Project policy.

An **effective workspace** is the directory a particular turn actually uses. It starts with the Project root and may be replaced by an account-owned Sandbox workspace. The Sandbox plugin can expose a worktree with its own branch, base reference, label, and path while keeping it attached to the same Project policy.

This distinction matters operationally:

- Project access answers **which project** an account may use.
- Sandbox selection answers **which account-owned checkout** the turn should use for that Project.
- The path guard answers **whether a concrete path** is inside the permitted roots.

File and terminal integrations must use this shared resolution instead of accepting arbitrary paths. A read-only shell clamp is a tool-policy guard; Sandbox confinement is the runtime isolation layer.

## Stores and authority

SQLite is the durable source of truth. Core host stores cover accounts, Projects, settings, prompts, external identities, plugin configuration and secrets, while focused stores cover brain transcripts, events, usage, delegation, memory, embeddings, and dashboard data. `BrainStore` is the brain-facing facade over those focused stores. Plugin-owned state uses the plugin database capability and remains behind that plugin's API; core does not read plugin tables directly.

The live PI session and plugin registry are in-memory execution objects. The daemon's `PluginRegistryProvider` can replace the registry generation during a reload, while durable state remains in SQLite. A second process, such as a delegated runner, reconstructs the same core against the same database but receives only the daemon layers and host controls appropriate to that process.

## Conversations and turns

A **conversation** is a durable `brain_sessions` row plus its `brain_messages` transcript. It has a model/provider pin, title, working directory, account anchor, and—when relevant—platform, direct-chat, fork, delegation, or recovery metadata.

A **turn** is one request through the embedded PI session. The live session holds ephemeral model context, tool state, approval state, and provider connections. SQLite remains authoritative and is updated before and during execution so the conversation can be rehydrated after eviction or restart.

A conversation's `user_id` is not always the person who most recently wrote. Shared platform rooms have an instance anchor and record `last_writer_user_id` separately. This prevents a room from being mistaken for one person's private conversation.

`TurnIdentity` is minted at the start of each turn by the identity resolver. Owner chat uses the authenticated account; a platform turn uses the adapter's verified sender and linked Elowen account; server automation carries an explicit acting account when one exists. In a shared room, personal tools, skills, memory, and account policy are resolved for the verified writer on every turn, never inherited from the room anchor. Unlinked writers receive no personal account namespace.

Conversation lifecycle operations are deliberately different:

- **Resume** rehydrates the same conversation.
- **Rollover** archives an idle or stale live context under a fresh session ID while preserving history.
- **Clear** wipes the conversation's durable content in place and keeps the same session identity.
- **Fork** creates a peer conversation with copied history/provenance.
- **Delegate** creates a child conversation with a durable parent and captured authority boundary.

## Session kinds

The brain composes tools and prompts for the session's origin, not just for the account row:

- `owner-chat` is the operator's own chat and operator-authored automation. It may use owner-only control tools.
- `trusted-channel` is a shared platform room where the sender has an operator-admin role. It may use all-project and full plugin capabilities available to that role, but it is still a room.
- `foreign-channel` is a shared room for other senders. It remains project- and role-scoped and never receives owner-only tools.

A shared channel is never turned into owner chat by an administrator role. Direct platform conversations can be marked as verified 1:1 chats, which enables personal routing and memory rules, but they still follow the channel adapter path.

## Tools: visibility is not authority

A **tool** is either core-owned or plugin-owned. The model may see only a filtered tool set, but visibility is not the final security check.

At composition time Elowen applies session kind, plugin grants, personal-tool ownership, and tool policy. At execution time it applies:

1. the acting account's plugin/tool authority;
2. the account's disabled-tool rules;
3. plan-mode restrictions;
4. ordered allow/ask/deny rules for the tool name or shell command;
5. plugin veto hooks, which may further refuse a permitted call but cannot widen access.

Shared rooms compose a stable tool registry because senders can change from turn to turn. Personal tools are then filtered and checked against the writer's identity at execution time, so one account cannot use another account's configured integration.

## Modes and approvals

The CLI and chat surfaces expose three relevant modes:

- **Build** — ordinary execution, subject to account and tool permissions.
- **Plan** — mutating calls are refused; `Write` and `Edit` may touch only the conversation's plan file. The full tool registry remains stable to avoid prompt-cache churn.
- **Workflow** — the subagent plugin uses a dependency graph of delegated nodes.

An `ask` permission can pause an interactive owner turn for approval. Channel, scheduled, and delegated turns have no interactive approval channel, so they use the captured non-interactive boundary and the account's unattended-ask setting. YOLO can approve calls that would otherwise ask, but it does not override an explicit deny.

## Plugins

A **plugin** is an independently loaded capability package. It can contribute tools, skills, prompt commands, platform adapters, routes, MCP tools, services, database state, configuration forms, and browser pages.

Plugins are not all equivalent:

- bundled infrastructure plugins ship with the Elowen package;
- optional domain and integration plugins come from the curated registry and are installed when needed;
- a plugin marked `userGrantable` is deny-by-default for non-administrators until granted to an account.

A plugin owns its vertical data, routes, tools, pages, services, migrations, and lifecycle. Core has no hidden product-domain implementation for a plugin to bypass; it provides shared runtime and narrow host infrastructure only. Core and sibling plugins access a plugin-owned domain through its declared typed control or host contract, never by importing internals or querying its tables directly. Controls belong to the current registry generation: resolve them again after reload instead of retaining an old generation. Missing owners and unmet dependencies fail closed as unavailable.

Instance configuration is declared by `configSchema`. Per-account configuration is declared by `userConfigSchema`, stored by `(user_id, plugin)`, and read by the plugin through `ctx.userConfig()`. Secret values are write-only at the API boundary and encrypted secrets use the instance or account secret namespace.

Plugin APIs normally live under `/plugins/<name>/api/*`; plugin browser pages mount under `/p/<plugin>/...`. Core routes take precedence over a plugin root mount.

## Memory

Memory is a **private, per-account** durable store. Owner-chat tools and verified platform turns resolve memory using the acting linked account. An unlinked shared-channel sender gets no personal memory.

Memory recall, deduplication, categories, post-turn curation, embeddings, and vitality are separate concerns:

- recall selects candidate entries within the account and current scope;
- categories can further scope entries to a Project;
- post-turn curation decides which durable facts to save;
- embeddings improve semantic retrieval but are optional;
- vitality and retention can move old low-value entries to the auditable trash state.

Uncategorized memories are never recalled. This is a fail-closed boundary, not merely a UI filter.

## Delegation and workflow DAGs

**Delegation** is a controlled child conversation. `Delegate` starts it; `DelegateContinue` resumes it; `DelegateStop` ends it. The child has a `DelegatedExecutionScope` containing the authority it may use.

The scope can capture:

- administrator, owner, and Project access;
- plugin tool allow/deny policy;
- non-interactive permission rules;
- focused role/context prompt appendices;
- whether read-only mode was requested or imposed;
- the principal that spawned it;
- the account whose personal tools, HOME, and Sandbox state it inherits.

The child cannot widen that scope. Continuation re-checks the parent's current authority, so revoked Projects, plugin grants, and stricter permission settings affect old children. The only supported widening is promotion of a read-only child that the same principal explicitly requested as read-only; the promoted scope is minted from the caller's current authority.

A **workflow DAG** is a set of delegated nodes with explicit dependencies. Independent nodes can run in parallel; dependent nodes receive completed dependency results. Nodes inherit the effective boundary of their creating node. The workflow engine is plugin-owned, while the host owns the durable session and recovery seams.

Delegated runs survive process boundaries through SQLite. The optional sub-agent runner is forked and supervised only by the daemon's runner pool; it builds the same brain core and plugin registry, owns its delegated session's store writes, and starts only the `subagent` platform needed for nested delegation. It has no HTTP server, ordinary platform gateways, scheduler, migrations, or maintenance loops. The daemon remains authoritative for dispatch, abort fencing, reverse workflow RPC, recovery, and delivery. Boot recovery claims interrupted rows before platform traffic starts, refuses unsafe replay after an unanswered tool call, and preserves completed results for bounded delivery.

## Providers and context management

A configured brain provider identifies the credentials and endpoint used to run a conversation. The durable session stores the configured provider entry together with the model because the same model ID can exist under multiple provider entries.

Context management is provided by PI plus Elowen extensions:

- automatic compaction can create a readable summary when the context fills;
- ChatGPT OAuth sessions can optionally use provider-side remote compaction;
- provider request capture is an attempt-level diagnostic read model;
- deferred tools can be activated through `ToolSearch` instead of occupying the initial prompt;
- prompt-cache stability is preserved by deterministic tool ordering and volatile per-turn reminders.

A model switch or plugin reload can require a session rebuild so the live in-memory session reflects the current prompt, tools, or provider route while the durable transcript remains intact.

## Channels and automation

A **platform channel** is a conversation delivered by a Discord, Telegram, Microsoft Teams, WhatsApp, or other adapter plugin. Adapters authenticate their own inbound webhook or gateway traffic and pass verified identity metadata to the core channel service.

The channel service reuses the normal brain pipeline. It applies the linked writer's Project policy, plugin grants, tool rules, memory toggles, model settings, and Sandbox workspace where applicable. Shared rooms remain shared; scheduled direct delivery is still a channel turn rather than an owner-chat send.

**Scheduling** is plugin-owned. Personal jobs execute as the owning account and report to that account's conversation. Instance jobs execute with operator authority and may notify configured channels. Ownership and grants are re-checked each time a job fires.

## Source-of-truth rules

When investigating behavior, use the layer that owns the decision:

- **Configuration defaults** — `src/store/configStore.ts` (`DEFAULT_CONFIG`, `defaultStored()`).
- **Authentication** — `src/api/auth.ts` and `src/api/middleware.ts`.
- **Project/path access** — `src/store/projectStore.ts`, `src/plugins/pathGuard.ts`, and `src/brain/service/workDir.ts`.
- **Tool composition** — `src/brain/session/capabilities.ts` and `src/brain/service/spawner.ts`.
- **Per-account plugin access** — `src/shared/pluginAccess.ts` and `src/plugins/registry.ts`.
- **Delegated authority** — `src/brain/delegatedScope.ts` and `src/brain/delegatedTurn.ts`.
- **Persistence** — `src/store/schema.sql`, `src/store/db.ts`, and `src/store/brainStore.ts`.
- **Plugin contracts** — `src/plugins/manifest.ts`, `src/plugins/api.ts`, and [`PLUGIN_DEV.md`](PLUGIN_DEV.md).
- **Web route ownership** — `src/api/routes/` for host routes, plugin manifests and entries for plugin routes/pages.

For a module-level map and operational lifecycle, see [`ARCHITECTURE.md`](ARCHITECTURE.md). For advanced implementation patterns see [`GUIDES.md`](GUIDES.md).
