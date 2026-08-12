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

Starts on port 4400 (override with `ELOWEN_PORT`). Initializes SQLite on first run.

### Environment reference

```bash
# Daemon
ELOWEN_PORT=4400
ELOWEN_HOST=127.0.0.1              # use 0.0.0.0 to expose externally
ELOWEN_DB=$HOME/.config/elowen/elowen.db
ELOWEN_PROJECT=elowen
ELOWEN_PROJECT_PATH=$PWD
ELOWEN_ALLOW_OPEN=                  # set to "1" for no-auth mode
ELOWEN_BOOTSTRAP_USER=              # initial admin username
ELOWEN_BOOTSTRAP_PASS=              # initial admin password

# CLI
ELOWEN_URL=http://localhost:4400
ELOWEN_TOKEN=
ELOWEN_AUTOSTART=1

# Autopilot relay
ELOWEN_RELAY_URL=
ELOWEN_RELAY_KEY=
ELOWEN_RELAY_MODEL=gpt-4o-mini

# Logging
ELOWEN_LOG_LEVEL=                   # debug | info | warn | error
ELOWEN_LOG_DIR=~/.config/elowen/logs # the default — state lives outside the package

# Web UI
ELOWEN_WEB_PORT=4500
ELOWEN_DAEMON_URL=http://localhost:4400

# Agent-injected
ELOWEN_CLI=elowen
```

### systemd service

Create `/etc/systemd/system/elowen-daemon.service`:

```ini
[Unit]
Description=Elowen AI agent orchestrator
After=network.target

[Service]
Type=simple
User=elowen
WorkingDirectory=/opt/elowen
ExecStart=/usr/bin/node /opt/elowen/dist/daemon/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=ELOWEN_DB=/opt/elowen/data/elowen.db
Environment=ELOWEN_PROJECT_PATH=/opt/elowen

[Install]
WantedBy=multi-user.target
```

And for the web UI (`elowen-web.service`):

```ini
[Unit]
Description=Elowen web UI
After=elowen-daemon.service

[Service]
Type=simple
User=elowen
WorkingDirectory=/opt/elowen/web
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=5
Environment=ELOWEN_DAEMON_URL=http://localhost:4400
Environment=NEXT_PRIVATE_STANDALONE=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now elowen-daemon elowen-web
journalctl -u elowen-daemon -f
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
docker build -t elowen .
docker run -d --name elowen -p 4400:4400 \
  -v elowen-data:/app/data \
  -e ELOWEN_DB=/app/data/elowen.db \
  -e ELOWEN_ALLOW_OPEN=1 \
  elowen
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
    server_name elowen.example.com;

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

    # Plugin webhooks (e.g. the Microsoft Teams bot endpoint /hooks/msteams/messages —
    # only needed when a plugin with an inbound webhook is enabled)
    location /hooks/ {
        proxy_pass http://127.0.0.1:4400;
        proxy_http_version 1.1;
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
- The `/hooks/` location exposes plugin webhooks (the msteams plugin's Bot Framework
  messaging endpoint lives there); requests are authenticated by the plugin itself
  (e.g. Microsoft's JWT), not by the daemon's bearer token
- Set `x-real-ip` for correct login rate limiting

## Monitoring

### Health check

```bash
curl http://localhost:4400/health
# {"ok":true}
```

### Logs

```bash
journalctl -u elowen-daemon -f
tail -f ~/.config/elowen/logs/daemon-$(date +%F).log   # file-based (ELOWEN_LOG_DIR)
```

The files are daily, so the name carries the date — there is no rolling
`daemon.log`. Settings → Data → Logs reads the same directory in the web UI.

## Updating

### Self-update

```bash
elowen update
```

The update is **self-locating** — it computes the npm `--prefix` from its own
binary path, so it works regardless of where Elowen is installed. It handles
root-owned prefixes transparently via sudo.

### Auto-update timer

Provisioned by `elowen install`. Checks hourly, respects running missions
(won't restart while a mission is active; missions require the agents
plugin). Toggle in Settings → System.

## Database

SQLite with WAL mode. Default: `~/.config/elowen/elowen.db`.

### Backup

```bash
sqlite3 /path/to/elowen.db ".backup /backup/elowen-$(date +%Y%m%d).db"
```

### Migration

New tables/columns use `CREATE TABLE IF NOT EXISTS`. No migration framework.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Daemon won't start | Node ≥22? tmux installed? Port 4400 free? DB path writable? |
| Sessions stuck | `elowen sessions` → kill with `DELETE /sessions/:name` |
| CLI can't reach daemon | `curl http://localhost:4400/health` |
| Web shows "unreachable" | Daemon running? `ELOWEN_DAEMON_URL` correct? |
| Login returns 429 | Wait 5 min or restart daemon. Ensure nginx sets `x-real-ip`. |
| Overseer died | Watchdog re-parks within 60s. Check `elowen sessions` for `elowen-overseer-*`. |
| Assistant won't start | Exec in `allowedExecs`? Non-admin user's `allowed_execs`? |
