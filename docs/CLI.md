# CLI Reference

The `orca` CLI connects to the daemon and provides quick access to common operations.

## Installation

```bash
npm link    # makes `orca` available globally
# or
node dist/cli/index.js <command>
```

## Global options

| Environment | Default | Description |
|---|---|---|---|
| `ORCA_URL` | `http://localhost:4400` | Daemon address |
| `ORCA_TOKEN` | — | API token for authenticated requests |
| `ORCA_AUTOSTART` | `1` | Auto-start daemon if not running (set `0` to disable) |

## Commands

### `orca ls`

List all tasks.

```bash
orca ls
```

Outputs a JSON array of tasks:

```json
[
  {
    "id": "my-project-a1b2c3",
    "title": "Fix login page",
    "status": "open",
    "priority": "P2",
    "labels": ["exec:sonnet"]
  }
]
```

### `orca ready`

List tasks that are ready to be worked on (all dependencies fulfilled).

```bash
orca ready
```

```json
[
  {
    "id": "my-project-b2c3d4",
    "title": "Add footer",
    "status": "open"
  }
]
```

### `orca sessions`

List active tmux sessions.

```bash
orca sessions
```

```json
["orca-SwiftLake0", "orca-CalmRidge1"]
```

### `orca close`

Close a task with a result summary and outcome. Used by agents to signal completion.

```bash
orca close my-project-a1b2c3 --summary "Fixed the login redirect bug" --outcome ok
orca close my-project-d4e5f6 --summary "Could not reproduce the issue" --outcome fail
```

Flags:
| Flag | Description |
|---|---|
| `--summary <text>` | Human-readable result description |
| `--outcome ok|fail` | Outcome of the task |

Calls `PATCH /tasks/:id` with `status: "closed"`, `result_summary`, and `outcome`.

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
| `1` | Error (daemon unreachable, invalid command) |

## Adding commands

New CLI commands are added in `src/cli/index.ts`:

```typescript
case 'mycommand':
  console.log(JSON.stringify(await c.mycommand(), null, 2));
  break;
```

And the corresponding method in `src/cli/client.ts`:

```typescript
async mycommand() { return this.req('/my-endpoint'); }
```
