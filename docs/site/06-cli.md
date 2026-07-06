---
title: CLI
slug: cli
order: 6
eyebrow: Reference
---

# CLI

The `orca` CLI is a second way to talk to and drive the same agent — this time from
your terminal. Everything you can do from the [Web UI](web-ui) has a command-line
counterpart: chat with the [Brain](brain-chat), inspect and close [tasks](tasks-missions),
plan [missions](tasks-missions), and manage the daemon. It is the low-friction,
scriptable surface of the agent — one small binary, sensible defaults, no ceremony.

The CLI connects to the daemon over its REST API. If the daemon is not running, the
CLI auto-starts it for you. Set `ORCA_AUTOSTART=0` to disable that and manage the
daemon yourself.

## Global options

```
orca [command] [options]
```

The CLI resolves its connection from three environment variables. In a normal
single-machine setup you never touch them — `orca login` caches a token and the
defaults point at your local daemon.

| Env var | Default | Description |
|---------|---------|-------------|
| `ORCA_URL` | `http://localhost:4400` | Daemon URL |
| `ORCA_TOKEN` | — | API token (auto-resolved via login cache) |
| `ORCA_AUTOSTART` | `1` | Auto-start the daemon from the CLI |

## Daemon lifecycle

The daemon is the REST API on `:4400`; the web UI runs alongside it on `:4500`.
These commands bring the agent up, take it down, and keep it current.

| Command | Purpose |
|---------|---------|
| `orca up` | Start the daemon + web UI |
| `orca down` | Stop the daemon |
| `orca status` | Daemon health check |
| `orca update` | Self-update to the latest npm version |
| `orca install` | Guided setup wizard (first-run) |

## Tasks

Tasks are the atomic unit of work the agent performs. See
[Tasks & Missions](tasks-missions) for the full model.

| Command | Purpose |
|---------|---------|
| `orca ls` | List tasks |
| `orca ready` | List ready (open, non-blocked) tasks |
| `orca close <id>` | Close a task (with `--summary` and `--outcome`) |
| `orca send <name>` | Send keystrokes to a live agent's tmux session |
| `orca api <method> <path>` | Raw API call (e.g. `orca api GET /tasks`) |

`orca send` is your one-click intervention from the terminal: type straight into a
running agent's session without leaving the shell. `orca api` gives you the raw REST
surface for scripting or debugging.

## Missions & autopilot

Missions group tasks; epics group missions. Autopilot is the automated
planning/execution layer that decomposes a goal and drives it through phases, with an
overseer gating decisions. See [Agents & Autonomy](agents-autonomy) for autonomy
levels L0–L3.

| Command | Purpose |
|---------|---------|
| `orca plan <goal>` | Decompose a goal into phases (autopilot) |
| `orca plan submit --phases '[...]'` | Submit manual phases (Pilot agent) |
| `orca overseer poll` | Decision loop for parked overseer agents |
| `orca overseer decide --id <id> --approve <bool>` | Submit a verdict |
| `orca ask <question>` | Free-text Q&A with the autopilot (worker ↔ overseer) |

## Notes (handoff)

Notes carry context between mission phases so the next agent picks up where the last
one left off — the handoff record that keeps a long mission coherent.

| Command | Purpose |
|---------|---------|
| `orca note add <target> <body>` | Leave a handoff note for the next phase |
| `orca note ls <target>` | Read all notes for a mission (oldest first) |

## Chat with the agent

`orca chat` opens an interactive conversation with the Brain — the same embedded agent
core you talk to in the web dock and over Discord/WhatsApp. It reasons, calls tools,
edits files, and runs commands, all from your terminal. This is the CLI face of the
conversation described in [Brain & Chat](brain-chat).

| Command | Purpose |
|---------|---------|
| `orca chat` | Interactive chat with the Brain |
| `orca chat --new` | Start a fresh conversation |
| `orca chat --session <id>` | Resume a past conversation |

Inside the chat, slash commands steer the conversation:

| Command | Purpose |
|---------|---------|
| `/model` | Switch the AI model for this conversation |
| `/compact` | Summarize context to reduce token usage |
| `/sessions` | List and resume past conversations |
| `/delete` | Delete a conversation |
| `/help` | Show available commands |

The tools the agent can reach in a CLI chat are still governed by RBAC: your account's
per-user tool access and per-project visibility apply exactly as they do in the web UI.
The terminal is a different door into the same agent, not a way around your permissions.

## Auth

| Command | Purpose |
|---------|---------|
| `orca login` | Authenticate with the daemon (caches token at `~/.config/orca/token`) |
| `orca sessions` | List live tmux sessions |

`orca login` caches a token so subsequent commands run without re-authenticating.
`orca sessions` lists the live tmux agent sessions you can attach to or intervene in.

## Environment reference

The CLI itself reads just three environment variables — the connection settings
already covered under [Global options](#global-options): `ORCA_URL`, `ORCA_TOKEN`,
and `ORCA_AUTOSTART`. In a normal single-machine setup you never touch them.

The daemon reads a larger set — database path, bind host/port, relay settings,
bootstrap credentials, logging — but those configure the server, not the CLI. To keep
a single source of truth, the full variable table lives in one place:
[Configuration](configuration).

[Next: Brain & Chat](brain-chat)
