# Deployment

## Prerequisites

- **Node.js** ≥22 (ESM)
- **tmux** ≥3.x
- **npm**

## Production build

```bash
npm ci --omit=dev
npm run build
```

`npm run build` runs `tsc -p tsconfig.json`, copies `src/store/schema.sql` into `dist/store/`, and copies the entire `prompts/` directory into `dist/prompts/`. The CLI entrypoint is `dist/cli/index.js`; the daemon entrypoint is `dist/daemon/index.js`.

## Running the daemon

### Direct

```bash
node dist/daemon/index.js
```

Starts on port 4400 (override with `ORCA_PORT`). The daemon auto-initializes the SQLite database from `dist/store/schema.sql` on first run.

### Environment block

All supported environment variables (defaults shown):

```bash
# Daemon
ORCA_PORT=4400
ORCA_DB=$HOME/.config/orca/orca.db
ORCA_PROJECT=orca
ORCA_PROJECT_PATH=$PWD
ORCA_ALLOW_OPEN=              # set to "1" to run without auth
ORCA_BOOTSTRAP_USER=          # initial admin username (one-time seed)
ORCA_BOOTSTRAP_PASS=          # initial admin password (one-time seed)

# CLI
ORCA_URL=http://localhost:4400
ORCA_TOKEN=                   # bearer token for CLI requests
ORCA_AUTOSTART=1              # set to "0" to disable CLI daemon autostart

# Autopilot relay (LLM)
ORCA_RELAY_URL=
ORCA_RELAY_KEY=
ORCA_RELAY_MODEL=gpt-4o-mini

# Logging (internal)
ORCA_LOG_LEVEL=               # debug | info | warn | error (default info)
ORCA_LOG_DIR=$PWD/logs        # log directory

# Web UI (Next.js)
NEXT_PUBLIC_ORCA_URL=http://localhost:4400

# Agent-injected (set by the daemon on spawned agent env, not by the operator)
# ORCA_PLAN_JOB=<jobId>       # Pilot agent
# ORCA_MISSION=<missionId>    # Overseer agent
# ORCA_TOKEN=<agent-scoped>   # every spawned agent
```

A complete example launch:

```bash
ORCA_PORT=4400 \
ORCA_DB=/opt/orca/data/orca.db \
ORCA_PROJECT_PATH=/opt/orca \
ORCA_BOOTSTRAP_USER=admin \
ORCA_BOOTSTRAP_PASS=secure-pass \
node dist/daemon/index.js
```

If no users exist and no `ORCA_BOOTSTRAP_USER`/`ORCA_BOOTSTRAP_PASS` is set, the daemon logs a warning — login will be impossible until a user is seeded.

### systemd service

Create `/etc/systemd/system/orca.service`:

```ini
[Unit]
Description=Orca AI agent orchestrator
After=network.target

[Service]
Type=simple
User=orca
WorkingDirectory=/opt/orca
ExecStart=/usr/bin/node /opt/orca/dist/daemon/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=ORCA_DB=/opt/orca/data/orca.db
Environment=ORCA_PROJECT_PATH=/opt/orca
Environment=ORCA_BOOTSTRAP_USER=admin
Environment=ORCA_BOOTSTRAP_PASS=change-me

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now orca
sudo journalctl -u orca -f     # tail logs
```

### Docker

```dockerfile
FROM node:22-alpine
RUN apk add --no-cache tmux
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build
EXPOSE 4400
CMD ["node", "dist/daemon/index.js"]
```

Build and run:

```bash
docker build -t orca .
docker run -d \
  --name orca \
  -p 4400:4400 \
  -v orca-data:/app/data \
  -e ORCA_DB=/app/data/orca.db \
  orca
docker logs -f orca
```

## Web frontend

### Build

```bash
cd web
npm ci --omit=dev
npm run build
```

The build runs `scripts/copy-monaco.mjs` first (copies Monaco editor workers into `public/`), then `next build`.

### Serve

Use the Next.js production server (not static export):

```bash
cd web
NEXT_PUBLIC_ORCA_URL=http://localhost:4400 npm start   # default port 3000
```

The web UI is typically served on port 4500:

```bash
NEXT_PUBLIC_ORCA_URL=http://your-server:4400 npx next start -p 4500
```

### Reverse proxy (nginx)

```nginx
server {
    listen 443 ssl;
    server_name orca.example.com;

    # Web UI
    location / {
        proxy_pass http://127.0.0.1:4500;
        proxy_http_version 1.1;
    }

    # Daemon API + SSE (direct, no rewrite prefix)
    location /api/ {
        proxy_pass http://127.0.0.1:4400;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        proxy_set_header x-real-ip $remote_addr;
    }
}
```

Notes:

- SSE requires `proxy_buffering off` and a long `proxy_read_timeout` (86400 s = 24 h)
- Set `x-real-ip` so the login rate limiter sees the real client IP (it prefers `x-real-ip` over `x-forwarded-for`)
- The daemon enables CORS for all origins; restrict it in code for production

## Environment variables reference

| Variable | Default | Description |
|---|---|---|
| `ORCA_URL` | `http://localhost:4400` | Daemon URL for CLI |
| `ORCA_TOKEN` | — | API token for CLI requests |
| `ORCA_AUTOSTART` | `1` | Let CLI auto-start the daemon; `0` disables |
| `ORCA_DB` | `~/.config/orca/orca.db` | SQLite database path |
| `ORCA_PORT` | `4400` | Daemon HTTP port |
| `ORCA_PROJECT` | `orca` | Default project slug |
| `ORCA_PROJECT_PATH` | `cwd` | Default project working directory |
| `ORCA_RELAY_URL` | — | LLM relay base URL (for autopilot) |
| `ORCA_RELAY_KEY` | — | LLM relay API key |
| `ORCA_RELAY_MODEL` | `gpt-4o-mini` | LLM relay model name |
| `ORCA_BOOTSTRAP_USER` | — | Initial admin username (one-time seed) |
| `ORCA_BOOTSTRAP_PASS` | — | Initial admin password (one-time seed) |
| `ORCA_ALLOW_OPEN` | — | Allow open (no auth) mode when set to `1` |
| `ORCA_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `ORCA_LOG_DIR` | `cwd/logs` | Log directory |
| `NEXT_PUBLIC_ORCA_URL` | `http://localhost:4400` | Daemon URL for web UI |

### Runtime config

Additional security + autopilot settings are managed via `GET/PUT /config` (stored in the SQLite `settings` table):

- `security.tokenTtlDays` — auth token expiry in days (default 30); expired tokens are purged every hour
- `allowedExecs` — list of executors that may be spawned
- `autopilot.{model, overseerModel, pilotExec, overseerExec, apiUrl, apiKeySet, reviewOnDone, notes, prompt}` — planning + overseer config
- `defaults.{exec, autonomy, maxSessions}` — new-task defaults
- `providers.{claude-code, opencode, codex}.{bin, args}` — CLI binary config

API keys are write-only: `apiKeySet` (boolean) is exposed in `GET /config`, the key value is never returned.

## Database

SQLite with WAL mode. Default path is `~/.config/orca/orca.db` (configurable via `ORCA_DB`).

### Backup

```bash
sqlite3 /path/to/orca.db ".backup /backup/orca-$(date +%Y%m%d).db"
```

### Migration

New tables or columns are added via `src/store/schema.sql` using `CREATE TABLE IF NOT EXISTS`. No migration framework — handle structural changes manually. The daemon reads the schema from `dist/store/schema.sql` (copied at build time).

## Monitoring

### Health check

```bash
curl http://localhost:4400/health
# {"ok":true}
```

### Logs

With systemd:

```bash
journalctl -u orca -f
```

With Docker:

```bash
docker logs -f orca
```

Application logs (file-based, controlled by `ORCA_LOG_DIR` / `ORCA_LOG_LEVEL`):

```bash
tail -f $PWD/logs/daemon.log
```

## Troubleshooting

### Daemon won't start

- Check Node.js version: `node --version` (needs ≥22)
- Check tmux is installed: `tmux -V`
- Check port 4400 is free: `lsof -i :4400`
- Check the SQLite path is writable (`ORCA_DB`)
- Check `ORCA_ALLOW_OPEN=1` is set when running without users
- Check `ORCA_BOOTSTRAP_USER`/`ORCA_BOOTSTRAP_PASS` are set on first run if you want auth

### Sessions stuck

If an agent dies without closing its task:

```bash
orca sessions                                                    # list sessions
curl -X DELETE http://localhost:4400/sessions/orca-Agent42       # kill manually
curl -X PATCH -d '{"status":"open"}' http://localhost:4400/tasks/task-id  # reset task
```

The **stuck detector** (60 s loop) usually handles this automatically — it reverts tasks whose agent died without `orca close` and escalates after 2 relaunch attempts. The **janitor** (60 s) kills zombie tmux sessions whose task is already closed/cancelled.

### CLI can't reach daemon

```bash
ORCA_AUTOSTART=0 orca ls      # check if the daemon is truly down
curl http://localhost:4400/health
```

If the daemon is stuck, kill it and let systemd/Docker restart it:

```bash
kill $(lsof -t -i :4400)
```

### Web UI shows "orca daemon unreachable"

- Verify the daemon is running on port 4400
- Check `NEXT_PUBLIC_ORCA_URL` points to the correct address
- Check CORS isn't blocked (daemon enables CORS for all origins)
- If the dev server on :4500 serves broken CSS chunks, kill the :4500 pid and run `next start` (not `next dev`) — turbopack dev cache can go stale

### Login returns 429

The login rate limiter caps 10 attempts per 5-minute window per IP (prefers `x-real-ip`). Wait 5 minutes or restart the daemon to clear the in-memory counter. Ensure nginx sets `x-real-ip` so the limiter sees distinct clients.

### Overseer died mid-mission

The overseer watchdog (`reconcileOverseers()`, 60 s) re-parks a fresh overseer for any active mission whose agent session is missing, and kills orphan overseer sessions. No manual action needed; verify with `orca sessions` that `orca-overseer-<missionId>` reappears within a minute.