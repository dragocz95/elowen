---
title: Configuration
slug: configuration
order: 10
eyebrow: Reference
---

# Configuration

Orca is configured through environment variables and runtime settings stored
in the SQLite database.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_URL` | `http://localhost:4400` | Daemon URL for CLI |
| `ORCA_TOKEN` | — | API token for CLI requests |
| `ORCA_AUTOSTART` | `1` | Auto-start daemon from CLI |
| `ORCA_DB` | `~/.config/orca/orca.db` | SQLite database path |
| `ORCA_PORT` | `4400` | Daemon HTTP port |
| `ORCA_HOST` | `127.0.0.1` | Daemon bind address (`0.0.0.0` to expose) |
| `ORCA_PROJECT` | `orca` | Default project slug |
| `ORCA_PROJECT_PATH` | `cwd` | Default project working directory |
| `ORCA_RELAY_URL` | — | LLM relay base URL |
| `ORCA_RELAY_KEY` | — | LLM relay API key |
| `ORCA_RELAY_MODEL` | `gpt-4o-mini` | LLM relay model |
| `ORCA_BOOTSTRAP_USER` | — | Initial admin username |
| `ORCA_BOOTSTRAP_PASS` | — | Initial admin password |
| `ORCA_ALLOW_OPEN` | — | Open (no auth) mode when `1` |
| `ORCA_LOG_LEVEL` | `info` | Log level (debug/info/warn/error) |
| `ORCA_LOG_DIR` | `cwd/logs` | Log directory |
| `ORCA_DAEMON_URL` | `http://localhost:4400` | Daemon URL for web BFF proxy |
| `ORCA_WEB_PORT` | `4500` | Web UI port |
| `ORCA_CLI` | `orca` | CLI binary path (for spawned agents) |

## Runtime config

Managed via `GET /config` and `PUT /config` API (or **Settings** page).

### Models

| Setting | Description |
|---------|-------------|
| Presets | Claude Sonnet, DeepSeek v4 Flash, Kimi k2.7, Minimax m2.7, Codex gpt-5.4 |
| Custom models | Add any model by label, provider, and model ID |
| Model notes | Descriptions used by autopilot's `autoModel` picker |
| `allowedExecs` | Which executors may be spawned (global allow-list) |

Model toggles, adds, edits, and description edits auto-save immediately.

### Autopilot

| Setting | Relay mode | CLI Agents mode |
|---------|------------|-----------------|
| Backend | Uses LLM relay API | Spawns a Pilot agent in the repo |
| Planner model | `autopilot.model` | Uses Pilot's own model |
| Overseer model | `autopilot.overseerModel` | `overseerExec` (e.g. `sonnet`) |
| API key | Required | Not needed |
| Review on done | Optional | Optional |

### Brain providers

| Type | Description |
|------|-------------|
| **Manual** | Statically configured provider (base URL, API key, models) |
| **Auto-fetch** | Fetches model list from `/v1/models` endpoint |
| **OAuth** | Connected accounts (Anthropic, Copilot, OpenAI) |

Each provider has its own API key, base URL, and model list. Keys are
write-only — the daemon never returns them.

### GitHub

| Setting | Description |
|---------|-------------|
| Token | GitHub personal access token |
| Base branch | Default PR target branch |
| Auto-open | Open PR on first phase commit |
| Verify command | Shell command run before closing PR |

### Providers (CLI)

| Setting | Per provider |
|---------|-------------|
| Binary path | Override default CLI binary location |
| Extra args | Additional CLI flags |
| Skip permissions | Pass `--dangerously-skip-permissions` |
| Resume sessions | Continue prior CLI session on respawn |

### Plugins

Each plugin has its own config section with schema-generated forms. See
[Plugins](plugins).

### Defaults

| Setting | Default | Description |
|---------|---------|-------------|
| Executor | `sonnet` | Default agent model |
| Autonomy | `L3` | Default autonomy level |
| Max sessions | `1` | Default max parallel agents |
| Token TTL | `30` | Auth token expiry in days |

[Next: Account & Security](account-security)
