---
title: Architecture
slug: architecture
order: 12
eyebrow: Reference
---

# Architecture

Elowen is a self-hosted Node.js application with one authoritative daemon, a separate Next.js Web UI, SQLite persistence, and pluggable capabilities. The architecture is intentionally small: every product surface observes or controls the same agent runtime instead of carrying its own copy of chat, task, or permission state.

```text
Browser ──> Next.js Web UI ──> daemon ──> SQLite
                 │                │
Terminal CLI ────┼────────────────┤
Platform plugins ─────────────────┤
                                  ├── embedded brain sessions
                                  └── tmux-backed task workers
```

## Processes and boundary

The **daemon** is the source of truth. It exposes the authenticated REST API, server-sent events, terminal streaming endpoints, the embedded brain runtime, scheduling, task and mission services, plugin registry, and SQLite stores. The normal local daemon port is `4400`.

The **Web UI** is a separate Next.js process, normally on `4500`. Browser requests go through its same-origin backend-for-frontend proxy to the daemon. The browser never talks directly to SQLite, and the Web UI does not duplicate daemon authorization or business state.

The **CLI** is a client of the same daemon. API-backed CLI operations can start a local daemon when needed; explicit lifecycle commands manage services without relying on that autostart behavior. Chat platforms are plugins that adapt messages into the same brain-turn pipeline.

## Source map

```text
src/
├── api/          Hono routes, validation, SSE, injected dependencies
├── brain/        embedded agent sessions, turns, policy, memory integration
├── cli/          terminal client, chat TUI, setup, lifecycle commands
├── daemon/       composition root, bootstrap, timers
├── embeddings/   embedding provider and background queue
├── integrations/ project, Git, and external-CLI integration helpers
├── mcp/          built-in MCP server
├── overseer/     mission planning, scheduling, review, liveness
├── plugins/      manifest parsing, loader, registry, hook bus
├── spawn/        external coding-agent process launch/resume
├── store/        SQLite-backed data stores and schema
├── terminal/     terminal streaming
├── tmux/         tmux abstraction
└── shared/       shared types, executor metadata, the daemon↔web wire contract

web/
├── app/          Next.js routes, BFF proxy, global styles
├── components/   shared UI primitives and shell
├── modules/      route-level product features
└── lib/          queries, mutations, client/server helpers

plugins/
└── <name>/       elowen-plugin.json, ESM entry, optional i18n and helpers
```

Tests mirror these areas under `tests/` and `web/tests/`. The contributor guide documents build and validation commands; this page describes runtime boundaries rather than internal deployment details.

## The brain and a turn

The embedded brain is an in-process PI-based agent session. It has one live session per conversation, an event stream, selected model/provider, effective policy, and a durable view of conversation history. The daemon—not a UI client—owns session lifecycle and determines who can access it.

For a normal user message, the turn pipeline assembles the effective identity and permissions, memory, selected tools and skills, hook contributions, dynamic turn context, and the user's message. Dynamic context can be placed before or after that message. It is deliberately ephemeral: it is sampled for the turn, framed as context, and never persisted as a conversation message or changed system prompt.

Messages that arrive during a running turn enter a durable queue. When the current turn settles, the queue is delivered in order. Compaction persists a summarized history tail; idle rollover can begin a fresh session after a configured gap — except while a terminal still has the conversation open, which is left alone so a user returning to it does not find it silently replaced. These mechanics are otherwise shared by Web UI, CLI, and platform calls.

## Tasks, missions, and workers

Tasks persist in SQLite and are associated with a project. They may run on the embedded brain or an external coding-agent CLI. External agents are launched through the spawn/tmux layer so their terminal can be watched and their lifecycle can be reconciled with task state.

The mission engine coordinates an epic and phase tasks. It handles readiness, dependency ordering, scheduling, autonomy, optional pilot/overseer roles, liveness checks, escalation, and optional Git worktrees for PR workflows. The mission engine owns orchestration; UI modules render its current state rather than inventing a parallel workflow.

## Plugins and capabilities

At startup and reload, the loader reads each enabled `elowen-plugin.json`, validates it against the current API version, and calls its ESM entry's `register(ctx)`. Contributions flow into one shared `PluginRegistry` used to build a brain turn.

Plugins can offer tools, skills, commands, hooks, platform adapters, configuration, and presentation metadata. Their context is scoped. Capability declarations are deny-by-default for runtime mutations and protected reads such as shared embeddings. Observational hooks remain isolated from mutating hooks; a plugin failure does not become permission to rewrite another plugin's behavior.

## Data and events

SQLite stores projects, tasks, dependencies, missions, users, access assignments, configuration, conversations, messages, memory, usage, and plugin-owned state. Stores are the data layer; route handlers delegate to injected services rather than querying the database from the Web UI.

The event bus publishes state changes to connected clients. The Web UI uses normal query/mutation flows plus event-driven invalidation or updates, while terminal streaming and PTY transport use their dedicated routes. A state change therefore has one origin and can be reflected consistently across the dashboard, task detail, terminal, and chat.

## Security model

Authentication and authorization are enforced at daemon routes and again at execution-sensitive seams. Users have roles and scoped projects; allowed executors and disabled tools further narrow what a user's agent can use. Provider secrets remain daemon-side. Plugin configuration marks secrets as write-only. The Web UI's proxy is a transport boundary, not a substitute for authorization.

Read [Account & Security](account-security) for user-facing controls, [Configuration](configuration) for operational settings, and [Plugin development](../PLUGIN_DEV.md) for the extension contract.

[Back to start](getting-started)
