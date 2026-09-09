# Elowen Documentation

Elowen is a self-hosted AI agent with one daemon, durable SQLite state, a Web UI, a terminal CLI, chat-platform adapters, and manifest-driven plugins. The same account, Project, memory, tool policy, and conversation model can be used from the supported surfaces.

## Choose a documentation set

- [`site/`](site/) is the public operator manual. It covers installation, first use, the Web UI, CLI commands, chat, memory, Projects, plugins, scheduling, channels, configuration, and troubleshooting.
- The documents in this directory are for contributors and operators who need implementation boundaries, API contracts, deployment details, and verification commands.

## Public operator manual

| Topic | Page |
| --- | --- |
| Getting started | [First account, Project, provider, and conversation](site/01-getting-started.md) |
| Installation | [Install](site/02-install.md) · [Docker](site/03-docker.md) · [Production updates](site/04-production-updates.md) |
| Web and CLI | [Web UI](site/05-web-ui.md) · [CLI](site/06-cli.md) · [Slash commands](site/07-slash-commands.md) · [CLI keybinds](site/08-cli-keybinds.md) |
| Conversations | [Brain and chat](site/09-brain-chat.md) · [Memory](site/10-memory.md) · [Usage and costs](site/11-usage-costs.md) · [Account preferences](site/12-account-preferences.md) |
| Workflows and models | [Sub-agents and workflows](site/13-tasks-missions.md) · [Providers and models](site/14-agents-providers.md) · [Autonomy and safety](site/15-autonomy-safety.md) |
| Projects and integrations | [Projects, Sandbox, and GitHub](site/16-projects-workflow.md) · [Scheduling](site/17-scheduling.md) · [Channels](site/18-channels.md) · [Plugins](site/23-plugins.md) |
| Channels | [Discord](site/19-channels-discord.md) · [Telegram](site/20-channels-telegram.md) · [Microsoft Teams](site/21-channels-teams.md) · [WhatsApp](site/22-channels-whatsapp.md) |
| Extensions and administration | [Skills](site/24-skills.md) · [MCP](site/25-mcp.md) · [Configuration](site/26-configuration.md) · [Users and access](site/27-users-access.md) |
| Reference | [Troubleshooting](site/28-troubleshooting.md) · [Glossary](site/29-glossary.md) |
| Plugin reference | [Files](site/30-files-plugin.md) · [Terminal](site/31-terminal-plugin.md) · [Sandbox](site/32-sandbox-plugin.md) · [Sub-agents](site/33-subagent-plugin.md) · [Web](site/34-web-plugin.md) · [MCP](site/35-mcp-plugin.md) · [Session helpers](site/36-session-helpers.md) · [Chat platforms](site/37-chat-platform-plugins.md) · [Microsoft 365](site/38-microsoft-365-plugin.md) · [Code tools](site/39-code-tools.md) · [Browser](site/40-browser-plugin.md) · [Cron jobs](site/41-cronjob-plugin.md) · [Image tools](site/42-image-tools.md) · [OneDrive](site/43-onedrive-plugin.md) · [Sites](site/44-sites-plugin.md) · [Skills](site/45-skills-plugin.md) · [Stats](site/46-stats-plugin.md) · [Todo](site/47-todo-plugin.md) · [Voice bot](site/48-voice-bot-plugin.md) |

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
| [Web UI](WEB.md) | Next.js routes, BFF authentication, data flow, plugin pages, and UI boundaries. |
| [UX](UX.md) | Current web interaction, accessibility, responsive, overlay, and autosave contracts. |
| [Brand](brand/README.md) | Contributor-facing brand asset usage and visual constraints. |
| [Feature studies](features/README.md) | Dated research notes comparing one domain against another agent, recording why a design decision was taken. |

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
- **Projects** register filesystem roots and expose read-only Git state in core. Worktrees, explicit-path commits, branch publication, pull requests, reviews, checks, and merges belong to enabled Sandbox/GitHub integrations. A Project declares its execution target: the host filesystem, or a managed environment that runs in its own persistent container.
- **Sandbox** is account-scoped. It provides persistent HOME, Git worktrees, process leases, managed project environments, and guarded cleanup; non-operator confinement is enabled by default where supported.
- **Permissions** combine account/plugin grants, tool allow/deny state, ordered per-call `allow`/`ask`/`deny` rules, Project policy, and execution-time identity checks.
- **Plugins** own vertical slices and are loaded from manifests. Their tools, routes, services, browser pages, settings, secrets, and lifecycle are not silently recreated by core.
- **Memory** is account-owned and durable by default, with optional administrator-configured shared Project pools. Recall, categorization, and embeddings are separate capabilities; the browser is only a projection of server state.
- **Context management** keeps three mechanisms apart: compaction summarizes history at the cost of one provider request, cold clearing mechanically replaces old tool results and stale runtime framing once the provider cache has expired, and deferred tools stay out of the prompt until `ToolSearch` fetches them.

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
