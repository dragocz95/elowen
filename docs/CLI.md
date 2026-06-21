# CLI Reference

The `orca` CLI connects to the daemon and provides quick access to common operations. Also used by spawned reasoning agents (Pilot, Overseer) to submit plans and answer decisions.

## Installation

```bash
npm link    # makes `orca` available globally
# or
node dist/cli/index.js <command>
```

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
["orca-SwiftLake0", "orca-CalmRidge1"]
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
    "labels": ["exec:sonnet", "agent:Atlas0"],
    "guardrails": ["schema", "migration"]
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
```

Flags:

| Flag | Description |
|---|---|
| `--id <id>` | Decision ID from `orca overseer poll` |
| `--approve` | Approve the action (confidence defaults to `0.7` when omitted) |
| `--escalate` | Escalate to a human (sets confidence to `0`) |
| `--confidence <0..1>` | Confidence level |
| `--rationale "<text>"` | Reason for the decision |

Calls `POST /missions/:missionId/overseer/decide`. Requires `ORCA_MISSION` to be set.

> **Note:** The destructive heuristic (`isDestructive()`) is applied server-side at enqueue time and is authoritative — the agent's `--approve` cannot override a destructive classification.

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

New CLI commands are added in `src/cli/index.ts` by adding a `case` to the `switch` statement in `run()`:

```typescript
case 'mycommand':
  console.log(JSON.stringify(await c.mycommand(), null, 2));
  break;
```

And the corresponding method in `src/cli/client.ts`:

```typescript
async mycommand() { return this.req('/my-endpoint'); }
```
