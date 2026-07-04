---
title: CLI
slug: cli
order: 6
eyebrow: Reference
---

# CLI

The `orca` CLI connects to the daemon and provides quick access to common
operations. It auto-starts the daemon if not running (set `ORCA_AUTOSTART=0`
to disable).

## Global options

```
orca [command] [options]
```

| Env var | Default | Description |
|---------|---------|-------------|
| `ORCA_URL` | `http://localhost:4400` | Daemon URL |
| `ORCA_TOKEN` | — | API token (auto-resolved via login cache) |
| `ORCA_AUTOSTART` | `1` | Auto-start daemon from CLI |

## Daemon lifecycle

| Command | Purpose |
|---------|---------|
| `orca up` | Start daemon + web UI |
| `orca down` | Stop daemon |
| `orca status` | Daemon health check |
| `orca update` | Self-update to latest npm version |
| `orca install` | Guided setup wizard (first-run) |

## Tasks

| Command | Purpose |
|---------|---------|
| `orca ls` | List tasks |
| `orca ready` | List ready (open, non-blocked) tasks |
| `orca close <id>` | Close a task (with `--summary` and `--outcome`) |
| `orca send <name>` | Send keystrokes to a live agent's tmux session |
| `orca api <method> <path>` | Raw API call (e.g. `orca api GET /tasks`) |

## Missions & autopilot

| Command | Purpose |
|---------|---------|
| `orca plan <goal>` | Decompose goal into phases (autopilot) |
| `orca plan submit --phases '[...]'` | Submit manual phases (Pilot agent) |
| `orca overseer poll` | Decision loop for parked overseer agents |
| `orca overseer decide --id <id> --approve <bool>` | Submit a verdict |
| `orca ask <question>` | Free-text Q&A with the autopilot (worker ↔ overseer) |

## Notes (handoff)

| Command | Purpose |
|---------|---------|
| `orca note add <target> <body>` | Leave a handoff note for the next phase |
| `orca note ls <target>` | Read all notes for a mission (oldest first) |

## Chat

| Command | Purpose |
|---------|---------|
| `orca chat` | Interactive chat with the Orca AI brain |
| `orca chat --new` | Start a fresh conversation |
| `orca chat --session <id>` | Resume a past conversation |

Chat commands (inside the chat UI):

| Command | Purpose |
|---------|---------|
| `/model` | Switch the AI model for this conversation |
| `/compact` | Summarize context to reduce token usage |
| `/sessions` | List and resume past conversations |
| `/delete` | Delete a conversation |
| `/help` | Show available commands |

## Auth

| Command | Purpose |
|---------|---------|
| `orca login` | Authenticate with the daemon (caches token at `~/.config/orca/token`) |
| `orca sessions` | List live tmux sessions |

## Environment reference

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_URL` | `http://localhost:4400` | Daemon URL for CLI |
| `ORCA_TOKEN` | — | API token for CLI requests |
| `ORCA_AUTOSTART` | `1` | Let CLI auto-start the daemon |
| `ORCA_DB` | `~/.config/orca/orca.db` | SQLite database path |
| `ORCA_PORT` | `4400` | Daemon HTTP port |
| `ORCA_HOST` | `127.0.0.1` | Daemon bind address |
| `ORCA_PROJECT` | `orca` | Default project slug |
| `ORCA_PROJECT_PATH` | `cwd` | Default project working directory |
| `ORCA_RELAY_URL` | — | LLM relay base URL |
| `ORCA_RELAY_KEY` | — | LLM relay API key |
| `ORCA_RELAY_MODEL` | `gpt-4o-mini` | LLM relay model |
| `ORCA_BOOTSTRAP_USER` | — | Initial admin username |
| `ORCA_BOOTSTRAP_PASS` | — | Initial admin password |
| `ORCA_ALLOW_OPEN` | — | Open (no auth) mode when `1` |
| `ORCA_LOG_LEVEL` | `info` | Log level |
| `ORCA_LOG_DIR` | `cwd/logs` | Log directory |

[Next: Brain & Chat](brain-chat)
