# Deployment

## Prerequisites

- **Node.js** ≥22
- **tmux** ≥3.x
- **npm**

## Production build

```bash
npm ci --omit=dev
npm run build
```

## Running the daemon

### Direct

```bash
node dist/daemon/index.js
```

Starts on port 4400. The daemon uses `src/store/schema.sql` (auto-copied to `dist/` during build) to initialize the SQLite database.

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

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now orca
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
  orca
```

## Web frontend

### Build

```bash
cd web
npm ci --omit=dev
npm run build
```

### Serve

The static output is in `web/out/`. Serve with any static server:

```bash
npx serve web/out
```

Or via the Next.js production server:

```bash
cd web
npm start  # runs on port 3000
```

Set `NEXT_PUBLIC_ORCA_URL` to the daemon URL (e.g., `https://orca.example.com`).

### Reverse proxy (nginx)

```nginx
server {
    listen 443 ssl;
    server_name orca.example.com;

    # Web UI
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
    }

    # Daemon API + SSE
    location /api/ {
        rewrite ^/api(/.*)$ $1 break;
        proxy_pass http://127.0.0.1:4400;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
    }
}
```

SSE requires `proxy_buffering off` and long `proxy_read_timeout`.

## Environment variables

| Variable | Default | Description |
|---|---|---|---|
| `ORCA_URL` | `http://localhost:4400` | Daemon URL for CLI |
| `ORCA_TOKEN` | — | API token for CLI requests |
| `ORCA_AUTOSTART` | `1` | Let CLI auto-start the daemon |
| `ORCA_DB` | `~/.config/orca/orca.db` | SQLite database path |
| `ORCA_PORT` | `4400` | Daemon HTTP port |
| `ORCA_PROJECT` | `orca` | Default project slug |
| `ORCA_PROJECT_PATH` | `cwd` | Default project working directory |
| `ORCA_RELAY_URL` | — | LLM relay base URL (for autopilot) |
| `ORCA_RELAY_KEY` | — | LLM relay API key |
| `ORCA_RELAY_MODEL` | `gpt-4o-mini` | LLM relay model name |
| `ORCA_BOOTSTRAP_USER` | — | Initial admin username |
| `ORCA_BOOTSTRAP_PASS` | — | Initial admin password |
| `ORCA_ALLOW_OPEN` | — | Allow open (no auth) mode when set to `1` |
| `NEXT_PUBLIC_ORCA_URL` | `http://localhost:4400` | Daemon URL for web UI |

## Database

SQLite with WAL mode. Default path is `~/.config/orca/orca.db` (configurable via `ORCA_DB`).

### Backup

```bash
sqlite3 /path/to/orca.db ".backup /backup/orca-$(date +%Y%m%d).db"
```

WAL mode allows concurrent reads during writes, but for consistent backups use the `.backup` command.

### Migration

New tables or columns are added via `src/store/schema.sql` using `CREATE TABLE IF NOT EXISTS`. No migration framework — handle structural changes manually.

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

## Troubleshooting

### Daemon won't start

- Check Node.js version: `node --version` (needs ≥22)
- Check tmux is installed: `tmux -V`
- Check port 4400 is free: `lsof -i :4400`
- Check SQLite path is writable (`ORCA_DB`)
- Check `ORCA_ALLOW_OPEN=1` is set when running without users

### Sessions stuck

If an agent dies without closing its task:

```bash
orca sessions          # list sessions
curl -X DELETE http://localhost:4400/sessions/orca-Agent42   # kill manually
curl -X PATCH -d '{"status":"open"}' http://localhost:4400/tasks/task-id  # reset
```

### CLI can't reach daemon

```bash
ORCA_AUTOSTART=0 orca ls   # check if daemon is truly down
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
