---
title: Glossary
slug: glossary
order: 29
eyebrow: Help
group: Help
---

# Glossary

The terms used by Elowen in the web UI, CLI, channels, and documentation.

## Runtime and conversations

| Term | Meaning |
| --- | --- |
| **daemon** | The backend process that owns the API, brain sessions, authentication, storage, plugins, and background loops. It normally listens on `127.0.0.1:4400`. See [Install](install). |
| **web UI** | The browser application served separately from the daemon, normally at `http://localhost:4500`. It talks to the daemon through its proxy. See [Web UI](web-ui). |
| **brain** | Elowen's embedded conversational runtime. It reads a message, reasons about it, calls permitted tools, and produces the answer. See [Brain & Chat](brain-chat). |
| **provider** | A configured AI account or API endpoint that supplies one or more models. Providers are managed in **Settings → Elowen AI**. |
| **model** | The concrete AI model selected for a conversation or account. The server default and an account override are separate settings. See [Account Preferences](account-preferences). |
| **conversation** | Durable message history that can be resumed after a restart or from another supported surface. `/new` starts another conversation; `/clear` empties the current one in the CLI and web UI. |
| **session** | The live runtime state for one conversation, including its active model, context, permissions, tools, and working directory. |
| **compaction** | Summarizing older conversation context so a long session can continue within the model's context window. Use `/compact` to request it and `/stats` to inspect context usage. |
| **channel** | An external chat surface connected through a plugin, such as Discord, Telegram, Microsoft Teams, or WhatsApp. See [Channels](channels). |

## Projects, workspaces, and execution

| Term | Meaning |
| --- | --- |
| **project** | A registered directory and access boundary. Project access determines which files and paths an account and its delegated work may use. See [Projects & Workflow](projects-workflow). |
| **Sandbox** | Elowen's execution and workspace boundary. It owns account-specific homes and workspaces and prevents a turn from silently using another account's workspace. |
| **workspace** | An account-owned Git worktree created from a Project, usually on a generated branch. The active workspace can become the working directory for that account's turns. |
| **worktree** | A Git working directory attached to a repository and branch. Sandbox workspaces are worktrees; deleting one requires a clean tree and no active processes. |
| **tool** | One callable action available to the brain, such as reading a file, running a command, searching code, or calling a plugin API. Tools have schemas and pass through permission checks. See [Plugins](plugins). |
| **terminal** | The interactive shell and pseudo-terminal surface. Terminal sessions use `tmux`; ordinary embedded chat does not require `tmux` to answer. |
| **plan mode** | A CLI or web chat mode for analysing and proposing an approach before editing. Its write restrictions are a guardrail, not a replacement for Sandbox isolation. |
| **build mode** | A CLI or web chat mode for carrying out an implementation with the available tools. |
| **workflow mode** | A CLI or web chat mode that runs a directed graph of delegated sub-agents. Independent nodes can run in parallel; dependent nodes wait for their inputs. See [Autonomy & Safety](autonomy-safety). |

## Accounts and permissions

| Term | Meaning |
| --- | --- |
| **account** | A user identity in an Elowen instance. Conversations, memory, permissions, provider overrides, projects, plugin access, and integrations are scoped to accounts where the feature supports it. |
| **operator** | An administrator account with instance-level control, such as managing users, system settings, plugins, and lifecycle actions. |
| **permission rule** | An account rule for a Bash command pattern or tool name. Its action is `allow`, `ask`, or `deny`; the last matching rule wins. Edit rules in **Account → Elowen AI**. |
| **YOLO** | The setting that automatically approves tool permission asks. `/yolo` changes the current CLI session; the account default is configured in **Account → Elowen AI**. Use it only when the account and task are trusted. |
| **permission boundary** | The effective set of tools and rules a turn may use. A delegated child receives a captured boundary and cannot widen it. |
| **read-only sub-agent** | A delegated `explore` or `plan` child with a narrower tool set. Its shell is restricted, but read-only is a safety boundary rather than a guarantee that no filesystem write syscall can ever occur. |
| **sub-agent** | A separate child conversation assigned one focused task. It has its own session and result, and inherits the caller's account and access boundary. |

## Memory and search

| Term | Meaning |
| --- | --- |
| **memory** | A durable fact stored for later conversations, such as a preference, architectural decision, or environment detail. Memory is account-scoped and may also be organized by project category. See [Memory](memory). |
| **memory category** | A named folder and classifier description used to organize memories. An uncategorized memory is not normally recalled. |
| **embedding** | A numeric representation of text used for meaning-based search. Embeddings support semantic memory and code search; keyword retrieval can still work without an embedding provider. |
| **semantic search** | Search by meaning using embeddings, rather than only matching the literal words in a query. |
| **vitality** | The recall-likelihood signal that changes as a memory is used and ages. It affects ranking and retention; a low-vitality, non-pinned memory can become evictable under the configured retention policy. |

## Extensions and integrations

| Term | Meaning |
| --- | --- |
| **plugin** | An installable capability bundle. A plugin can add tools, settings, channels, routes, scheduled work, or other surfaces. Enable and configure plugins in **Settings → Plugins**. See [Plugins](plugins). |
| **skill** | A reusable Markdown procedure loaded when a task matches its description. Skills provide instructions; they do not grant permissions. See [Skills](skills). |
| **MCP** | Model Context Protocol, a standard for connecting tool servers to Elowen. MCP servers and their discovered tools are managed through the MCP surface. See [MCP](mcp). |
| **GitHub connection** | An account-scoped GitHub authorization used by the GitHub plugin. A connection is not shared between Elowen accounts and can require reconnection if it expires. |
| **project mapping** | The GitHub plugin's association between an Elowen Project and a GitHub repository. A connected account may still need a mapping before project-level GitHub actions are available. |
| **cron job** | A recurring prompt executed on a schedule, for example a daily report or periodic check. It is provided by the scheduling plugin when that plugin is enabled. See [Scheduling](scheduling). |
| **wake-up** | A one-shot scheduled prompt that runs once at a specified time or after a delay, then removes itself. See [Scheduling](scheduling). |

## Configuration and storage

| Term | Meaning |
| --- | --- |
| **configuration directory** | The persistent state directory, `~/.config/elowen` by default. It contains the database, logs, plugin data, credentials, plans, attachments, and other runtime state. |
| **`ELOWEN_DB`** | Environment variable that overrides the SQLite database path. |
| **`ELOWEN_LOG_DIR`** | Environment variable that overrides the directory for daily daemon and web logs. |
| **`plugin-secrets.key`** | The key used to decrypt plugin secrets stored in the database. It must be backed up with the database; restoring only the database is insufficient. |

[Back to start](getting-started)
