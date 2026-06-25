# CLI Reference

The `orca` CLI connects to the daemon and provides quick access to common operations. Also used by spawned reasoning agents (Pilot, Overseer) to submit plans and answer decisions.

## Installation

```bash
npm install -g orcasynth   # makes `orca` available globally
# or, from a source checkout:
node dist/cli/index.js <command>
```

## Two command families

The CLI has two kinds of commands:

- **API commands** (`ls`, `ready`, `sessions`, `close`, `plan`, `overseer`, `api`) talk to the daemon REST API. They auto-start the daemon if it isn't running (disable with `ORCA_AUTOSTART=0`).
- **Lifecycle commands** (`up`, `down`, `status`, `update`, `install`) manage the daemon itself — they never auto-start it. Run `orca` with no argument for the interactive launcher menu.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ORCA_URL` | `http://localhost:4400` | Daemon address |
| `ORCA_TOKEN` | — | API token for authenticated requests (set by daemon for spawned agents) |
| `ORCA_AUTOSTART` | enabled | Auto-start daemon if not running (set `0` to disable) |
| `ORCA_PLAN_JOB` | — | Plan job ID injected by daemon for Pilot agent (`orca plan submit`) |
| `ORCA_MISSION` | — | Mission ID injected by daemon for Overseer agent (`orca overseer poll/decide`) |

> **Note:** `ORCA_DB`, `ORCA_PORT`, `ORCA_PROJECT_PATH`, `ORCA_BOOTSTRAP_USER`, and `ORCA_BOOTSTRAP_PASS` are daemon-side environment variables — the CLI does not read them.

## Commands

### `orca ls`

List all tasks from the daemon.

```bash
orca ls
```

Outputs a JSON array of tasks:

```json
[
  {
    "id": "orca-ab12cd34",
    "title": "Fix login page",
    "status": "open",
    "priority": "P2",
    "labels": ["exec:sonnet"]
  }
]
```

Calls `GET /tasks`.

### `orca ready`

List tasks that are ready to be worked on (open, non-epic, all dependencies fulfilled).

```bash
orca ready
```

```json
[
  {
    "id": "orca-ef56gh78",
    "title": "Add footer",
    "status": "open"
  }
]
```

Calls `GET /tasks/ready`.

### `orca sessions`

List active orca-managed tmux sessions (`orca-*` prefix).

```bash
orca sessions
```

```json
[
  { "name": "orca-SwiftLake0", "role": "agent", "agent": "SwiftLake0" },
  { "name": "orca-pilot-Aria", "role": "pilot", "agent": "Aria" },
  { "name": "orca-overseer-m-my-project-a1b2c3d4", "role": "overseer", "agent": "", "missionId": "m-my-project-a1b2c3d4" }
]
```

Calls `GET /sessions`.

### `orca close`

Close a task with a result summary and outcome. Used by agents to signal completion.

```bash
orca close orca-ab12cd34 --summary "Fixed the login redirect bug" --outcome ok
orca close orca-ef56gh78 --summary "Could not reproduce the issue" --outcome fail
```

Flags:

| Flag | Description |
|---|---|
| `--summary <text>` | Human-readable result description |
| `--outcome ok\|fail` | Outcome of the task (validated — exits with code 2 on invalid value) |

Calls `PATCH /tasks/:id` with `status: "closed"`, `result_summary`, and `outcome`.

### `orca plan submit`

Used by the **Pilot agent** to submit a structured plan for an async planning job. The job ID is injected via the `ORCA_PLAN_JOB` environment variable — the Pilot never passes it manually.

```bash
orca plan submit --phases '[{"title":"Set up database","type":"chore"},{"title":"Create API endpoints","type":"feature"}]'
```

Flags:

| Flag | Description |
|---|---|
| `--phases <json>` | JSON array of phase objects (title + type + optional agent/details) |

Calls `POST /plan/:jobId/submit`. Exits with error if `ORCA_PLAN_JOB` is not set or if `--phases` is not valid JSON.

### `orca overseer poll`

Used by the parked **Overseer agent** to long-poll for pending decisions. The CLI loop absorbs heartbeat responses (`{}`, sent every ~25s by the server to keep the HTTP connection alive) so the LLM is woken only for real decisions — not for empty keep-alive pings.

```bash
orca overseer poll
```

Outputs the next pending decision (an object with an `id` field) when one is available:

```json
{
  "id": "a1b2c3d4e5f6",
  "kind": "task",
  "context": {
    "title": "Set up database schema",
    "labels": ["exec:sonnet", "agent:Atlas0"]
  }
}
```

Blocks indefinitely, surfacing only decisions with an `id` or `error` field. The loop ends when the daemon kills the session (mission disengaged) or when an error arrives.

Requires `ORCA_MISSION` to be set (injected by the daemon at spawn time).

### `orca overseer decide`

Used by the parked **Overseer agent** to submit a verdict for a pending decision.

```bash
orca overseer decide --id a1b2c3d4e5f6 --approve --confidence 0.85 --rationale "Schema change is scoped and safe"
orca overseer decide --id b2c3d4e5f6 --escalate --rationale "This migrates production data — needs human review"
orca overseer decide --id c3d4e5f6a1b2 --choice opt_rollback --rationale "Rollback is the safest option"
```

A `question`-kind decision uses `--choice` to pick an option; a permission/review decision uses
`--approve` or `--escalate`.

Flags:

| Flag | Description |
|---|---|
| `--id <id>` | Decision ID from `orca overseer poll` |
| `--approve` | Approve the action (confidence defaults to `0.7` when omitted) |
| `--escalate` | Escalate to a human (sets confidence to `0`) |
| `--choice <optionId>` | Pick an option for a `question`-kind decision (overrides confidence to `0.7`) |
| `--confidence <0..1>` | Confidence level (default `0.7` for `--approve` / `--choice`, `0` for `--escalate`) |
| `--rationale "<text>"` | Reason for the decision |

Calls `POST /missions/:missionId/overseer/decide`. Requires `ORCA_MISSION` to be set.

> **Note:** The destructive heuristic (`isDestructive()`) is applied server-side at enqueue time and is authoritative — the agent's `--approve` cannot override a destructive classification.

### `orca api` (generic REST passthrough)

Generic authenticated REST passthrough — call any Orca endpoint with no per-endpoint CLI command.
Reads `ORCA_URL`/`ORCA_TOKEN` from the environment the daemon injects into every spawned agent, so an
agent (including the assistant) can drive any endpoint. A new REST endpoint needs zero CLI edits.

```bash
orca api GET /tasks
orca api POST /tasks '{"title":"Fix the build","project_id":1}'
orca api POST /tasks/plan '{"goal":"Add dark mode","project_id":1}'
orca api GET /sessions
```

The forward logic (headers, JSON parse, error handling) lives in the shared `callOrcaApi` core
(`src/shared/apiClient.ts`) — exactly the same path the MCP tools use, so the two never drift.

**Response** — the parsed JSON response body (pretty-printed), or the raw text when the body isn't JSON.

**Exit codes**

| Code | Meaning |
|---|---|
| `0` | HTTP 2xx |
| `1` | Non-2xx response (the body is still printed) |
| `2` | Usage error (`usage: orca api <METHOD> <path> [jsonBody]`) or invalid JSON body |

## Lifecycle commands

These manage the daemon itself and never auto-start it.

### `orca up`

Starts the daemon (:4400) and the web UI (:4500) in the background. Fails loudly if the daemon never
becomes healthy (prints `orca daemon did not become healthy` and exits non-zero).

### `orca down`

Stops the daemon and the web UI.

### `orca status`

Prints a one-glance block showing which services are running and healthy:

```
  orcasynth v1.4.15

  daemon  ●  running  :4400  healthy
  web     ●  running  :4500  healthy  http://localhost:4500
```

### `orca update`

Updates to the latest npm release and restarts the services in place. Self-locating and
systemd-aware — it targets its own install prefix and restarts the units. The reliable fallback is:

```bash
sudo npm install -g orcasynth@latest --prefix <install-prefix> && sudo systemctl restart orca-daemon orca-web
```

### `orca install`

Guided provisioning wizard (run as root): systemd units, a reverse proxy, and the first admin.
Supports unattended mode (`orca install --unattended`) and lets you choose the domain / IP:port /
localhost, TLS (Let's Encrypt where applicable), and the autopilot engine (agent CLI or API key).
See `orca install --help` for the flags.

## Daemon autostart

The CLI automatically starts the daemon if it isn't running:

1. Hits `GET /health`
2. If unreachable, spawns `node dist/daemon/index.js` as a detached child process
3. Polls health endpoint up to 50 times (100ms interval) until ready
4. Times out with `"orca daemon did not become healthy"` if daemon fails to start

Disable with `ORCA_AUTOSTART=0`:

```bash
ORCA_AUTOSTART=0 orca ls
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Error (daemon unreachable, invalid command, missing env var, invalid JSON) |
| `2` | Invalid `--outcome` value (must be `ok` or `fail`) |

## Adding commands

New daemon-backed commands are added in `src/cli/index.ts` by adding a `case` to the `switch` in `run()`:

```typescript
case 'mycommand':
  console.log(JSON.stringify(await c.mycommand(), null, 2));
  break;
```

And the corresponding method in `src/cli/client.ts`:

```typescript
async mycommand() { return this.req('/my-endpoint'); }
```

Add the command name to the `API_COMMANDS` set so the daemon auto-starts for it. Lifecycle commands
go through `runLifecycle()` in `src/cli/commands.ts` instead.

For a generic one-off, `orca api <METHOD> <path> [body]` reaches any endpoint with no CLI edit — both
the CLI and the MCP tools delegate to the shared `callOrcaApi` core in `src/shared/apiClient.ts`.
