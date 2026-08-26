# Elowen Documentation

Elowen is a self-hosted AI agent with one daemon, durable SQLite state, a Web UI, a terminal CLI, chat-platform adapters, and manifest-driven plugins. The same account, Project, memory, tool policy, and conversation model can be used from the supported surfaces.

## Choose a documentation set

- [`docs/site/`](site/) is the public operator manual. It covers installation, first use, the Web UI, CLI commands, chat, memory, Projects, plugins, scheduling, channels, configuration, and troubleshooting.
- The documents in this directory are for contributors and operators who need implementation boundaries, API contracts, deployment details, and verification commands.

## Public operator manual

| Start here | Covers |
| --- | --- |
| [Getting started](site/01-getting-started.md) | First account, Project, provider, and conversation. |
| [Install](site/02-install.md) | Local and shared-server installation paths. |
| [Web UI](site/05-web-ui.md) | Core pages, plugin pages, account access, and browser operation. |
| [CLI](site/06-cli.md) | Interactive chat, headless runs, slash commands, and local state. |
| [Brain and chat](site/09-brain-chat.md) | Conversations, modes, approvals, goals, and long-running turns. |
| [Memory](site/10-memory.md) | Account memory, retrieval, categories, and retention. |
| [Projects](site/16-projects-workflow.md) | Project roots, access, Git context, and development workspaces. |
| [Plugins](site/23-plugins.md) | Installation, enablement, grants, and plugin-owned features. |
| [Configuration](site/26-configuration.md) | Environment, provider, runtime, memory, and account settings. |
| [Access and security](site/27-users-access.md) | Accounts, Project assignments, tools, and permission policy. |
| [Troubleshooting](site/28-troubleshooting.md) | Readiness checks, logs, paths, and recovery steps. |

The public site may also link directly to the channel, scheduling, skills, MCP, and glossary pages under `docs/site/`.

## Developer and operator references

| Document | Description |
| --- | --- |
| [API Reference](API.md) | Hono REST route families, authentication, account access, and error behavior. |
| [Architecture](ARCHITECTURE.md) | Daemon construction, request flow, sessions, persistence, plugins, and recovery. |
| [CLI Reference](CLI.md) | Top-level commands, TUI behavior, headless output, key bindings, and local files. |
| [Concepts](CONCEPTS.md) | Domain vocabulary and the boundaries between conversations, Projects, memory, plugins, and permissions. |
| [Deployment](DEPLOYMENT.md) | Production installation, services, reverse proxy, and runtime configuration. |
| [Development](DEVELOPMENT.md) | Local setup, repository layout, build scripts, and contribution conventions. |
| [Guides](GUIDES.md) | Cross-stack implementation patterns, policy invariants, plugin lifecycle, Sandbox, GitHub, and recovery. |
| [Plugin Development](PLUGIN_DEV.md) | Plugin manifests, registry API, capabilities, browser UI, secrets, and testing. |
| [Security](SECURITY.md) | Authentication, authorization, path policy, secrets, and operational safeguards. |
| [Testing](TESTING.md) | Daemon, web, contract, integration, and end-to-end verification. |
| [Web UI](WEB.md) | Next.js routes, BFF authentication, data flow, plugin pages, terminal transport, and UI boundaries. |

## System in one view

```text
Browser ──> Next.js Web UI ──> same-origin /api BFF ──┐
Terminal CLI ─────────────────────────────────────────┼──> Elowen daemon ──> SQLite
Chat-platform adapters ───────────────────────────────┘          │
                                                                ├──> plugin services
                                                                └──> optional delegated runners
```

The daemon is the authority for authentication, account ownership, Project access, tool policy, conversation state, and persistence. The browser never receives a daemon bearer token: its BFF converts an httpOnly session cookie into a server-side Bearer header. The CLI sends a Bearer header directly.

## Current feature boundaries

- **Conversations and goals** are durable brain sessions in SQLite. A persistent goal reuses the ordinary account, Project, plugin, tool, and permission boundaries.
- **Delegation and workflows** are provided by the `subagent` plugin. Children and workflow nodes inherit or narrow authority; they cannot widen it.
- **Projects** register filesystem roots and expose read-only Git state in core. Worktrees, explicit-path commits, branch publication, pull requests, reviews, checks, and merges belong to enabled Sandbox/GitHub integrations.
- **Sandbox** is account-scoped. It provides persistent HOME, Git worktrees, process leases, and guarded cleanup; non-operator confinement is enabled by default where supported.
- **Permissions** combine account/plugin grants, tool allow/deny state, ordered per-call `allow`/`ask`/`deny` rules, Project policy, and execution-time identity checks.
- **Plugins** own vertical slices and are loaded from manifests. Their tools, routes, services, browser pages, settings, secrets, and lifecycle are not silently recreated by core.
- **Memory** is account-scoped and durable. Recall, categorization, and embeddings are separate capabilities; the browser is only a projection of server state.

## Where to start in the code

| Concern | Primary locations |
| --- | --- |
| Daemon wiring and startup | `src/daemon/brainCore.ts`, `src/daemon/bootstrap.ts` |
| HTTP routes and auth | `src/api/routes/`, `src/api/auth.ts`, `src/api/middleware.ts` |
| Conversation lifecycle and turns | `src/brain/service/`, `src/brain/persistence.ts` |
| Tool composition and policy | `src/brain/session/capabilities.ts`, `src/brain/brainDeps.ts` |
| Accounts and Projects | `src/store/userStore.ts`, `src/store/projectStore.ts`, `src/plugins/pathGuard.ts` |
| Plugins and live reload | `src/plugins/`, `src/plugins/api.ts` |
| Delegation and workflow recovery | `src/subagent/`, `src/brain/delegatedTurn.ts`, `src/brain/recovery/` |
| CLI and TUI | `src/cli/`, `src/tmux/` |
| Web host | `web/app/`, `web/components/`, `web/modules/`, `web/lib/` |
| Browser plugin host | `web/app/p/[plugin]/[[...rest]]/page.tsx`, `web/lib/pluginUi.ts` |
| Shared web/daemon wire types | `src/shared/wireContract.ts`, `web/lib/types.ts` |

For repository setup and commands, read [`DEVELOPMENT.md`](DEVELOPMENT.md). For a change that crosses account, Project, plugin, or execution boundaries, read [`GUIDES.md`](GUIDES.md) and [`SECURITY.md`](SECURITY.md) before editing.

## Project links

- [GitHub repository](https://github.com/dragocz95/elowen)
- [npm package](https://www.npmjs.com/package/elowen)
- [Issue tracker](https://github.com/dragocz95/elowen/issues)
