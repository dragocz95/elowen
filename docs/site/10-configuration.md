---
title: Configuration
slug: configuration
order: 10
eyebrow: Reference
---

# Configuration

Orca is the personal AI agent you chat with — it reasons, calls tools, edits
files, and runs work for you. This page is how you tune that agent. Almost
everything works out of the box with sensible defaults, so most of the time you
change nothing; when you do want to steer behaviour, you do it in the
**Settings** page, backed by the daemon's `GET /config` and `PUT /config` API.
Simplicity is a core promise here: low friction, few required knobs, and edits
that auto-save immediately.

![Settings page with the category sidebar](images/settings-overview.png)

Configuration comes in two layers:

- **Environment variables** — read once at process start (ports, paths, bind
  address, bootstrap credentials). Set these before launching the daemon.
- **Runtime config** — everything you can change live in the **Settings** page.
  Grouped into ten categories that mirror the daemon exactly.

Settings live in the **Config** group of the web UI and are admin-gated. If you
manage a multi-user install, remember Orca has full RBAC: roles are `admin` and
`member`, and each user can carry a **different set of tools and permissions**
(which executors they may run, which brain tools are disabled for them, which
projects they see). Configuration below is workspace-wide; per-user grants live
in [Account & Security](account-security).

## Environment variables

Set these before the daemon starts. See [CLI](cli) for how the `orca` binary
reads them.

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

The daemon serves the REST API on **:4400**, the Next.js web UI runs on
**:4500**, and the SQLite database sits at `~/.config/orca/orca.db`. This small,
self-hosted footprint is the point — a lightweight app with professional-grade
code that you run yourself.

## Runtime config

Everything below is edited in the **Settings** page and persisted through
`GET /config` / `PUT /config`. The sections appear in the same order as the real
Settings categories: **models, providers, defaults, brain, memory, plugins,
autopilot, github, system, data**. Most edits auto-save as you make them.

## Models

The model catalog defines which models the agent and its workers can use.

| Setting | Description |
|---------|-------------|
| Presets | Claude Sonnet, DeepSeek v4 Flash, Kimi k2.7, Minimax m2.7, Codex gpt-5.4 |
| Custom models | Add any model by label, provider, and model ID |
| Model notes | Descriptions used by autopilot's `autoModel` picker |
| `allowedExecs` | Which executors may be spawned (global allow-list) |

Toggle a preset on or off, add a custom model, or edit a label — every toggle,
add, edit, and note change **auto-saves immediately**, so there is no separate
"Save" step. Model notes are free-text descriptions that autopilot's `autoModel`
picker reads when it chooses a model for a task, so a good note ("cheap, fast,
good for boilerplate") directly improves autonomous model selection. The global
`allowedExecs` allow-list is the workspace ceiling; per-user `allowed_execs`
narrows it further for individual members (see [Account & Security](account-security)).

## Providers (CLI)

Orca can drive four external coding-agent CLIs — **Claude Code** (`claude:`),
**OpenCode** (`opencode:`), **Codex** (`codex:`), and **Kilo Code** (`kilo:`) —
alongside the embedded Orca AI brain. This section configures each CLI provider.

| Setting | Per provider |
|---------|-------------|
| Binary path | Override the default CLI binary location |
| Extra args | Additional CLI flags passed on every spawn |
| Skip permissions | Pass the provider's `--dangerously-skip-permissions` flag |
| Resume sessions | Continue the prior CLI session on respawn |

Point each provider at a non-standard binary, append extra flags, or enable
session resume so a respawned agent picks up where it left off. Note: for **Kilo
Code**, the Skip-permissions toggle is a **no-op** — Kilo's auto-approval lives
in Kilo's own config, not in Orca. See [Agents & Autonomy](agents-autonomy) for
how executors map to autonomy levels.

## Defaults

The fallback settings applied to new work when you don't specify otherwise.

| Setting | Default | Description |
|---------|---------|-------------|
| Executor | `sonnet` | Default agent model |
| Autonomy | `L3` | Default autonomy level |
| Max sessions | `1` | Default max parallel agents |
| Token TTL | `30` | Auth token expiry in days |

These defaults keep first-run friction low: a fresh install can plan and execute
immediately without touching a single knob. Autonomy levels L0–L3 control how
much the agent may do without asking — see [Agents & Autonomy](agents-autonomy).

## Brain providers

The **Brain** is the embedded agent core you chat with in the web dock, the CLI,
and the chat platforms. This section connects it to model providers.

| Type | Description |
|------|-------------|
| **Manual** | Statically configured provider (base URL, API key, models) |
| **Auto-fetch** | Fetches the model list from a `/v1/models` endpoint |
| **OAuth** | Connected accounts (Anthropic, Copilot, OpenAI) |

Each provider has its own API key, base URL, and model list. Keys are
**write-only** — you set them here, but the daemon never returns them in any
response. Auto-fetch providers keep their model list current by querying
`/v1/models`; OAuth providers link a connected account instead of a raw key.

## Memory

The agent's long-term memory turns past events into recallable knowledge. This
section picks the two workspace-level models that power it.

| Setting | Description |
|---------|-------------|
| Embedding provider + model | Converts memories into vectors for semantic recall |
| Categorization model | Sorts memories into categories |
| Dimensions | Embedding vector size |

Both models inherit their API key and endpoint from the referenced brain
provider — there is no separate base URL to fill in. Changing the embedding
model lets you re-index existing memories, and changing the categorization model
lets you re-classify them. The stored memories themselves live in the **Memory**
module of the Operate group.

## Autopilot

Autopilot is Orca's automated planning and execution. It runs in one of two
modes, and you pick per workspace.

| Setting | Relay mode | CLI Agents mode |
|---------|------------|-----------------|
| Backend | Uses the LLM relay API | Spawns a Pilot agent in the repo |
| Planner model | `autopilot.model` | Uses the Pilot's own model |
| Overseer model | `autopilot.overseerModel` | `overseerExec` (e.g. `sonnet`) |
| API key | Required | Not needed |
| Review on done | Optional | Optional |

**Relay mode** calls a hosted LLM relay directly (needs an API key) and is the
lightest way to get planning. **CLI Agents mode** spawns a real Pilot agent in
the repository that plans and executes through the same executors your tasks use
(no relay key required). Either mode can optionally run a review pass when a task
reports done.

## GitHub

Connects the agent to your repositories so it can branch, commit, and open PRs.

| Setting | Description |
|---------|-------------|
| Token | GitHub personal access token |
| Base branch | Default PR target branch |
| Auto-open | Open a PR on the first phase commit |
| Verify command | Shell command run before closing a PR |

The verify command is your quality gate — the agent runs it before a PR is
closed, so a failing build or test suite blocks completion. See
[Projects & Workflow](projects-workflow) for the full git flow.

## Plugins

Every capability in Orca is a plugin you add or remove — chat platforms, tools,
memory, automation, UI, security, and development. Each installed plugin renders its **own**
config section here, generated from that plugin's schema, and each section is its
own collapsible so the page stays clean and uncluttered. Install, update, and
uninstall plugins through the marketplace. See [Plugins](plugins) for the full
catalog and the marketplace flow.

Because tools are plugins, and brain tools can be **disabled per user**, this is
also where the workspace-wide plugin set is defined that per-user grants then
narrow — one member can have terminal + files, another only chat.

## System & Data

**System** shows the running version and health of the two services, with a
one-click restart:

- Current version and an **Update** button, plus an auto-update toggle.
- Service health for the daemon (:4400) and web UI (:4500), with restart.

**Data** is the danger zone. It is **admin-only** and holds destructive actions —
notably delete-all — so it is gated behind the admin role and kept separate from
everyday settings. Treat it with care; there is no undo.

For the underlying process model, ports, and where state is stored, see
[Architecture](architecture).

[Next: Account & Security](account-security)
