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

`npm run build` compiles TypeScript, copies `src/store/schema.sql` and
`prompts/` into `dist/`.

## Running the daemon

### Direct

```bash
node dist/daemon/index.js
```

Starts on port 4400 (override with `ORCA_PORT`). Initializes SQLite on first run.

### Environment reference

```bash
# Daemon
ORCA_PORT=4400
ORCA_HOST=127.0.0.1              # use 0.0.0.0 to expose externally
ORCA_DB=$HOME/.config/orca/orca.db
ORCA_PROJECT=orca
ORCA_PROJECT_PATH=$PWD
ORCA_ALLOW_OPEN=                  # set to "1" for no-auth mode
ORCA_BOOTSTRAP_USER=              # initial admin username
ORCA_BOOTSTRAP_PASS=              # initial admin password

# CLI
ORCA_URL=http://localhost:4400
ORCA_TOKEN=
ORCA_AUTOSTART=1

# Autopilot relay
ORCA_RELAY_URL=
ORCA_RELAY_KEY=
ORCA_RELAY_MODEL=gpt-4o-mini

# Logging
ORCA_LOG_LEVEL=                   # debug | info | warn | error
ORCA_LOG_DIR=$PWD/logs

# Web UI
ORCA_WEB_PORT=4500
ORCA_DAEMON_URL=http://localhost:4400

# Agent-injected
ORCA_CLI=orca
```

### systemd service

Create `/etc/systemd/system/orca-daemon.service`:

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

[Install]
WantedBy=multi-user.target
```

And for the web UI (`orca-web.service`):

```ini
[Unit]
Description=Orca web UI
After=orca-daemon.service

[Service]
Type=simple
User=orca
WorkingDirectory=/opt/orca/web
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=5
Environment=ORCA_DAEMON_URL=http://localhost:4400
Environment=NEXT_PRIVATE_STANDALONE=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now orca-daemon orca-web
journalctl -u orca-daemon -f
```

### Docker

```dockerfile
FROM node:22-alpine
RUN apk add --no-cache tmux git
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build
EXPOSE 4400
CMD ["node", "dist/daemon/index.js"]
```

```bash
docker build -t orca .
docker run -d --name orca -p 4400:4400 \
  -v orca-data:/app/data \
  -e ORCA_DB=/app/data/orca.db \
  -e ORCA_ALLOW_OPEN=1 \
  orca
```

## Web frontend

```bash
cd web
npm ci --omit=dev
npm run build
npm start   # default port 3000
```

The web UI is typically served on port 4500 behind nginx.

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

    # Daemon API + SSE + MCP (BFF proxy — Next.js handles /api internally)
    location /api/ {
        proxy_pass http://127.0.0.1:4500;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        proxy_set_header x-real-ip $remote_addr;
    }

    # Real-PTY WebSocket terminal (bypasses BFF, goes straight to daemon)
    location /ws/ {
        proxy_pass http://127.0.0.1:4400;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400s;
        proxy_set_header x-real-ip $remote_addr;
    }

    # Service worker — must never be cached
    location = /sw.js {
        proxy_pass http://127.0.0.1:4500;
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
    }
}
```

Notes:
- SSE requires `proxy_buffering off` and `proxy_read_timeout 86400s`
- The `/ws/` location is required for real-PTY terminal streaming; without it,
  terminals fall back to snapshot mirror
- Set `x-real-ip` for correct login rate limiting

## Monitoring

### Health check

```bash
curl http://localhost:4400/health
# {"ok":true}
```

### Logs

```bash
journalctl -u orca-daemon -f
tail -f $PWD/logs/daemon.log   # file-based (ORCA_LOG_DIR)
```

## Updating

### Self-update

```bash
orca update
```

The update is **self-locating** — it computes the npm `--prefix` from its own
binary path, so it works regardless of where Orca is installed. It handles
root-owned prefixes transparently via sudo.

### Auto-update timer

Provisioned by `orca install`. Checks hourly, respects running missions
(won't restart while a mission is active). Toggle in Settings → System.

## Database

SQLite with WAL mode. Default: `~/.config/orca/orca.db`.

### Backup

```bash
sqlite3 /path/to/orca.db ".backup /backup/orca-$(date +%Y%m%d).db"
```

### Migration

New tables/columns use `CREATE TABLE IF NOT EXISTS`. No migration framework.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Daemon won't start | Node ≥22? tmux installed? Port 4400 free? DB path writable? |
| Sessions stuck | `orca sessions` → kill with `DELETE /sessions/:name` |
| CLI can't reach daemon | `curl http://localhost:4400/health` |
| Web shows "unreachable" | Daemon running? `ORCA_DAEMON_URL` correct? |
| Login returns 429 | Wait 5 min or restart daemon. Ensure nginx sets `x-real-ip`. |
| Overseer died | Watchdog re-parks within 60s. Check `orca sessions` for `orca-overseer-*`. |
| Assistant won't start | Exec in `allowedExecs`? Non-admin user's `allowed_execs`? |
