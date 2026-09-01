---
title: Glossary
slug: glossary
order: 29
eyebrow: Help
group: Help
---

# Glossary

The terms used by Elowen in the Web UI, CLI, channels, and documentation.

## Runtime and services

| Term | Meaning |
| --- | --- |
| **daemon** | The backend service that owns the API, authentication, storage, brain services, live session registry, plugin registry, and background loops. It normally listens on `127.0.0.1:4400`. |
| **web service** | The separate browser application, normally at `http://localhost:4500`. It communicates with the daemon through its proxy. |
| **service** | One of the managed daemon or web processes. `elowen status` reports whether each is running and healthy. |
| **brain** | Elowen's conversational runtime. It assembles a session, sends context to the selected model, executes permitted tools, and emits the answer. |
| **provider** | A configured AI account or API endpoint that supplies models. |
| **model** | A concrete model selected from the administrator's catalog and the account's allowed choices. |
| **conversation** | Durable message history that can be resumed after a restart or from another supported surface. `/new` starts another conversation; `/clear` empties the current history while keeping its identity. |
| **session** | Live runtime state for one conversation or platform room: model, context, permissions, tools, working directory, and lifecycle state. A session can be disposed and reassembled without deleting its durable conversation. |
| **live session registry** | The daemon's authoritative in-memory record of active sessions, turns, delegated edges, and abort ownership. Status and stop operations use it rather than guessing from persisted rows. |
| **parked turn** | Work paused at a safe boundary, commonly while waiting for a question, delegated result, shutdown recovery, or another continuation. Parked state can be persisted for safe resume. |
| **compaction** | Summarizing older session context so a conversation can continue within the model's context window. `/compact` requests it; `/stats` and `/context` show usage. |
| **context window** | The model's maximum prompt and response budget. Elowen reserves space for the current turn and may compact before the limit is reached. |
| **channel** | An external chat surface connected through a plugin, such as Discord, Telegram, Microsoft Teams, or WhatsApp. |

## Projects and execution

| Term | Meaning |
| --- | --- |
| **project** | A registered directory and access boundary. Project access determines which files and paths an account and its delegated work may use. |
| **Sandbox** | Elowen's account-scoped execution and workspace boundary. It prevents a turn from silently using another account's workspace. |
| **workspace** | An account-owned Git worktree created from a Project, usually on a generated branch. |
| **worktree** | A Git working directory attached to a repository and branch. Sandbox workspaces are worktrees. |
| **tool** | A callable action exposed to the brain, such as reading a file, running a command, searching code, or calling a plugin API. Tool calls pass through permission checks. |
| **terminal** | The interactive shell and pseudo-terminal surface. Terminal sessions use `tmux`; embedded chat does not need `tmux` for ordinary answers. |
| **plan mode** | A mode that proposes an approach before implementation. Its write and shell restrictions are execution guardrails, not filesystem isolation. |
| **build mode** | The mode for carrying out implementation with the available tools. |
| **workflow mode** | A mode that runs a directed acyclic graph of delegated sub-agents. Independent nodes can run in parallel; dependent nodes wait for their inputs. |
| **sub-agent** | A child conversation assigned one focused task. It has its own session and result and inherits the caller's authority boundary. |
| **sub-agent runner** | A forked child process that executes delegated turns outside the daemon event loop. Runners load the required brain and plugins, report lifecycle state to the daemon, and are supervised by a runner pool. |
| **runner pool** | The daemon-managed set of forked sub-agent runners. Its size can be automatic, explicitly limited, or disabled as an operational rollback. |
| **delegation** | A parent-to-child assignment created by `Delegate`. `DelegateContinue` resumes that child's transcript rather than the parent's. |
| **workflow DAG** | A directed acyclic graph of delegated nodes run by `WorkflowStart`; dependencies determine when a node may start. `WorkflowResume` retries only unfinished nodes. |

## Accounts and authority

| Term | Meaning |
| --- | --- |
| **account** | A user identity in an Elowen instance. Conversations, Memory, permissions, provider overrides, Projects, plugin access, and integrations are account-scoped where supported. |
| **operator** | An administrator account with instance-level control, including users, system settings, plugins, and lifecycle actions. |
| **permission rule** | An account rule for a Bash command pattern or tool name. Its action is `allow`, `ask`, or `deny`; the last matching rule wins. |
| **YOLO** | The setting that automatically approves eligible tool permission asks. It never overrides a deny rule or an unattended block. |
| **permission boundary** | The effective set of tools, projects, scopes, and rules a turn may use. Delegated work can narrow but not widen it. |
| **read-only sub-agent** | A delegated child with write tools removed and a non-destructive shell guardrail. It is not a complete filesystem sandbox. |
| **unattended run** | Work started without an interactive person available to answer a question, such as a scheduled job, channel turn, or delegated child. Its unattended policy controls unanswered permission asks. |

## Memory and search

| Term | Meaning |
| --- | --- |
| **Memory** | A durable, account-scoped fact stored for later conversations, such as a preference, architectural decision, or environment detail. |
| **memory category** | A named folder and classifier description used to organize Memory. Uncategorized facts are not normally recalled. |
| **embedding** | A numeric representation of text used for meaning-based retrieval. |
| **semantic search** | Search by meaning using embeddings rather than only matching literal words. |
| **vitality** | A recall-likelihood signal that changes as a memory is used and ages. It affects ranking and retention. |

## Plugins, registry, and integrations

| Term | Meaning |
| --- | --- |
| **plugin** | A capability bundle that can add tools, settings, channels, routes, pages, skills, scheduled work, or integrations. Plugins run as part of the Elowen installation. See [Plugins](plugins). |
| **plugin registry** | The live merged set of contributions from enabled bundled and installed plugins. Tools, routes, prompts, and capabilities are resolved from this registry and can be swapped during a live reload. |
| **plugin marketplace** | The curated source from which administrators install and update marketplace plugins. It is distinct from the live runtime registry. |
| **plugin grant** | A per-account grant for a `userGrantable` plugin's gated tools, API routes, UI, and contributed skills. It does not replace individual tool permissions or gate every plugin contribution. |
| **control** | A named runtime capability one plugin publishes for another plugin. `requiresControls` matches declared control keys, not specific plugin names; runtime resolution can still be unavailable when the provider is unconfigured or disabled. |
| **`requiresCore`** | A plugin manifest field naming the minimum Elowen version required for additive host APIs. The marketplace checks it before installing a plugin. |
| **live reload** | Applying a plugin registry change without restarting the daemon. If active work prevents a safe swap, the change remains pending until the work settles. |
| **skill** | A reusable Markdown procedure loaded by `SkillLoad` or explicit `/skill:<name>` when permitted. Skills provide instructions; they do not grant permissions. See [Skills](skills). |
| **MCP** | Model Context Protocol, a standard for connecting external tool servers to Elowen. The MCP plugin supports `stdio`, HTTP, and SSE transports, with personal and instance ownership scopes. See [MCP](mcp). |
| **deferred tool** | A tool advertised by name and description without its full schema until `ToolSearch` loads it. Deferral reduces prompt size and does not change permissions. |
| **GitHub connection** | An account-scoped GitHub authorization used by GitHub integrations. It can expire and require reconnection. |
| **project mapping** | The association between an Elowen Project and a GitHub repository used by project-level GitHub actions. |
| **cron job** | A recurring prompt executed on a schedule. |
| **wake-up** | A one-shot scheduled prompt that runs once, then removes itself. |

## Configuration, storage, and releases

| Term | Meaning |
| --- | --- |
| **configuration directory** | The persistent state directory, `~/.config/elowen` by default. It contains the database, logs, plugin data, credentials, plans, attachments, and tool-result spill files. |
| **`ELOWEN_DB`** | Environment variable overriding the SQLite database path. |
| **`ELOWEN_LOG_DIR`** | Environment variable overriding the directory for daily daemon and web logs. |
| **`plugin-secrets.key`** | The encryption key for plugin secrets stored in the database. It must be backed up with the database. |
| **release** | A versioned Elowen source/package state intended for installation. A git checkout or local package version is not proof that the version is published. |
| **published package** | The version available from the public npm registry and installable by `elowen update`. |
| **local build** | Artifacts built from a source checkout, including the daemon and, separately, the web bundle. Local builds can be newer than the published package. |
| **migration** | A database schema/data upgrade run automatically when the daemon boots a newer version. |

[Back to start](getting-started)
