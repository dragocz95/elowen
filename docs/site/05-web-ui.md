---
title: Web UI
slug: web-ui
order: 5
eyebrow: Everyday use
group: Everyday use
---

# Web UI

The Web UI observes and steers the same daemon used by the terminal and chat-platform plugins. It does not have a second conversation store, Project policy, permission model, or credential store.

Desktop navigation uses one shared rail. On smaller screens the same information becomes a linear layout with drawers rather than a compressed desktop composition.

## The shell

Every page shares authentication, localization, React Query state, command palette, account controls, and the advisor chat surface. Enabled plugins contribute their own navigation worlds and settings sections at runtime; disabling a plugin removes those pages without leaving a fake empty core screen.

## Core workspaces

| Route | Use it for |
| --- | --- |
| `/dash` | Current assistant activity, recent events, schedules, and setup signals. |
| `/chat` | Full-page conversation, model controls, queued messages, workflows, sub-agents, processes, and telemetry. |
| `/projects` | Project registration, access context, and read-only Git checkout state. |
| `/memory` | Durable memories, categories, vitality, retrieval, merge, restore, and purge. |
| `/settings` | Instance configuration and enabled plugin settings. |
| `/users` | Administrator account, Project, plugin, model, and tool access management. |
| `/account` | Personal profile, security, notifications, communication, model, and terminal preferences. |

Plugin pages render under `/p/<plugin>/<route>`. Their labels and localized copy come from the plugin manifest/i18n files, not from retired host dictionary namespaces.

![Elowen's dashboard](images/web-ui-dashboard.png)

## Chat

The chat dock is available across the product, and `/chat` expands the same conversation into a full-page view. Both surfaces use the same server-side session as the CLI and channel adapters.

- **Composer** — slash commands, file attachments, paste, and queued follow-ups.
- **Model controls** — switch model, reasoning effort, fast mode, plan/build mode, and conversation-level YOLO.
- **History** — search, rename, fork, export, delete, or start a conversation.
- **Todos** — the generic conversation checklist from the bundled todo plugin.
- **Sub-agents and workflows** — live progress and drill-in to each child conversation or workflow node.
- **Processes** — background shell processes owned by the current session/account.
- **Telemetry** — context, usage, goals, workflows, sub-agents, processes, Project, MCP, and LSP state.

Long conversations load lazily and preserve scroll position while older messages are fetched. Tool calls, reasoning, session changes, and workflow markers render in the transcript rather than in a separate task/mission UI.

## Projects

Projects defines the directories accounts may work in. The core page shows metadata, access context, branches, recent commits, sanitized remotes, current branch/HEAD/upstream, and dirty/untracked/ahead/behind state.

Core Projects does not display a PR switch, GitHub token, repository mapping, worktree lifecycle, publication, or merge action. File editors and any future local/remote workflow are plugin-owned and consume the same Project tenancy and path guard.

![Projects workspace](images/projects-list.png)

## Memory

The Memory workspace lets you inspect, search, categorize, merge, restore, or purge durable facts. List and detail views show importance, usage, category, audit history, and vitality. Retrieval runs the real recall pipeline and shows the score breakdown the assistant would receive.

## Settings

Core settings cover:

1. **System** — readiness, service state, updates, and token lifetime.
2. **Elowen AI** — provider accounts, agent identity, limits, retention, runtime, and context windows.
3. **Models** — visible model presets, custom entries, and notes.
4. **Data** — administrative maintenance and cleanup.
5. **Plugins** — installation, enable/disable, grants, logs, and plugin-owned sections.
6. **Memory** — embedding and categorization configuration.

Plugin credentials are never returned to the browser. New integration secrets live in the encrypted plugin vault; API responses expose only non-secret metadata or whether a value is set.

## Responsive and accessible behavior

Register-style workspaces preserve text status alongside color, keyboard row navigation, visible focus, error-before-loading rendering, and full-width mobile drawers. Confirm dialogs present server-provided previews, but the server remains responsible for authorization and stale-state checks.

[Next: CLI](cli)
