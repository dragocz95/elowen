# Deployment

This page covers building Elowen from a checkout, running its two processes, and provisioning a machine for service-managed operation.

## Supported installation paths

The supported machine provisioner is `elowen install`:

- **Debian or Ubuntu:** run it as root (`sudo elowen install`). It creates a dedicated service user, two systemd services, and an hourly update timer.
- **macOS:** run it as the current user, without `sudo`. It creates per-user LaunchAgents and binds to localhost.
- **Windows:** run Elowen inside WSL2. Native Windows is not supported because the runtime uses Linux tooling such as tmux and systemd.

The Linux provisioner requires `apt`; the macOS provisioner requires Homebrew when it must install tmux. Node.js 22 or newer is required on every platform.

For a packaged installation with Node.js already installed:

```bash
npm install -g elowen
elowen install
```

Use `elowen install --help` for unattended installation flags, service-user selection, deployment mode, reverse-proxy selection, and first-admin/model setup. The one-line installers in the repository perform the same package installation and then invoke `elowen install`.

## Build from a source checkout

A source build needs both dependency trees. The web application is not built by `npm run build`.

```bash
npm ci
npm ci --prefix web
npm run build
npm run build:web
```

The commands produce:

- `dist/` — compiled daemon, CLI, and bundled plugin runtime files, plus copied `prompts/` and `src/store/schema.sql`.
- `web-dist/` — the standalone Next.js server, static assets, and `public/` assets.

Do not patch `dist/` or `web-dist/` by hand. Rebuild them from source instead.

## Run the processes directly

The daemon and web UI are separate processes. Building or starting the daemon does not start the web UI.

Start the daemon from the repository root:

```bash
ELOWEN_PORT=4400 \
ELOWEN_HOST=127.0.0.1 \
ELOWEN_PROJECT_PATH="$PWD" \
node dist/daemon/index.js
```

Start the built web server in a second terminal:

```bash
PORT=4500 \
HOSTNAME=127.0.0.1 \
ELOWEN_DAEMON_URL=http://127.0.0.1:4400 \
node web-dist/server.js
```

For development without a build, use `npm run serve` for the daemon and `npm --prefix web run dev` for Next.js. Next.js uses port 3000 by default in this mode; set `PORT` if another port is required.

The daemon binds to `127.0.0.1:4400` by default. Keep it private when possible: a daemon bearer token can authorize powerful operations. Deliberately exposing it requires setting `ELOWEN_HOST` and placing an appropriate access boundary in front of it.

## Runtime configuration

The persistent default state directory is `~/.config/elowen`. `ELOWEN_DB` changes only the database path; `ELOWEN_LOG_DIR` changes the log directory.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ELOWEN_PORT` | `4400` | Daemon HTTP and WebSocket port. |
| `ELOWEN_HOST` | `127.0.0.1` | Daemon bind address. |
| `ELOWEN_DB` | `~/.config/elowen/elowen.db` | SQLite database path. |
| `ELOWEN_PROJECT` | `elowen` | Default project identifier for a directly started daemon. |
| `ELOWEN_PROJECT_PATH` | Current working directory | Default project path for a directly started daemon. |
| `ELOWEN_BOOTSTRAP_USER` / `ELOWEN_BOOTSTRAP_PASS` | Unset | Optional first-account bootstrap credentials when both are supplied. |
| `ELOWEN_LOG_LEVEL` | `info` | Minimum log level: `debug`, `info`, `warn`, or `error`. |
| `ELOWEN_LOG_DIR` | `~/.config/elowen/logs` | Directory for daily daemon and web log files. |
| `ELOWEN_DAEMON_URL` | `http://localhost:4400` in CLI/web integrations | URL used by clients and the web BFF to reach the daemon. |
| `ELOWEN_URL` | `http://localhost:4400` | CLI daemon URL. |
| `ELOWEN_TOKEN` | Unset | CLI bearer token, when one is supplied explicitly. |
| `ELOWEN_AUTOSTART` | `1` | Set to `0` to disable CLI auto-start behavior. |
| `ELOWEN_CLI` | `elowen` | CLI name used by launcher integrations. |

The web server itself reads the standard `PORT` and `HOSTNAME` variables. `ELOWEN_WEB_PORT` is an installer/launcher setting; it is not read by the Next.js server. In proxy-less IP deployment, the installer may also set `ELOWEN_WS_DIRECT_PORT` so the browser can connect directly to the daemon terminal WebSocket.

There is no supported general-purpose no-auth switch. Authentication is open only during the initial zero-user setup flow; after the first user exists, normal requests require a bearer token or the authenticated web session.

## Service-managed deployment

The installer writes these Linux units:

- `elowen-daemon.service`
- `elowen-web.service`
- `elowen-update.service`
- `elowen-update.timer`

The daemon unit runs the compiled `dist/daemon/index.js`; the web unit runs `web-dist/server.js`. The daemon drains active work during shutdown, and the systemd unit uses a longer stop timeout so delegated work can finish. The update timer starts 15 minutes after boot and checks hourly; auto-update must be enabled in Elowen settings before it installs a newer release.

Check the services after installation:

```bash
sudo systemctl status elowen-daemon elowen-web
sudo systemctl status elowen-update.timer
curl -fsS http://127.0.0.1:4400/health
```

On macOS, use the LaunchAgents created by `elowen install`; the service logs remain under `~/.config/elowen/logs/`.

## Reverse proxy

When a reverse proxy fronts the web UI, route browser traffic to the web process and only the terminal WebSocket and plugin webhooks directly to the daemon:

```nginx
server {
    listen 443 ssl;
    server_name elowen.example.com;

    # Browser image attachments are base64 JSON and may be up to 5 MB.
    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:4500;
        proxy_http_version 1.1;
    }

    # Next.js BFF: daemon API, SSE, and MCP requests.
    location /api/ {
        proxy_pass http://127.0.0.1:4500;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header x-real-ip $remote_addr;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
    }

    # Real PTY terminal streaming.
    location /ws/ {
        proxy_pass http://127.0.0.1:4400;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header x-real-ip $remote_addr;
        proxy_read_timeout 86400s;
    }

    # Only enable this location when an inbound plugin webhook is configured.
    location /hooks/ {
        proxy_pass http://127.0.0.1:4400;
        proxy_http_version 1.1;
        proxy_set_header x-real-ip $remote_addr;
    }

    location = /sw.js {
        proxy_pass http://127.0.0.1:4500;
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
    }
}
```

`proxy_buffering off` and a long `proxy_read_timeout` are required for SSE. The `/ws/` route is required for real-PTY terminal streaming. The `/hooks/` route is authenticated by the receiving plugin, not by the daemon bearer-token middleware. Forward `x-real-ip` from the trusted proxy so the daemon can apply its configured client-IP policy and login rate limits.

## Persistent state and backups

The database is only one part of the runtime state. Back up the complete `~/.config/elowen` directory when possible. It contains the database, logs, plugin data, plans, attachments, provider credentials, and other account state.

If backing up SQLite separately, retain the matching plugin secret key beside it:

```bash
sqlite3 /path/to/elowen.db \
  ".backup /backup/elowen-$(date +%Y%m%d).db"
install -m 600 /path/to/plugin-secrets.key \
  "/backup/plugin-secrets-$(date +%Y%m%d).key"
```

The database and `plugin-secrets.key` must come from the same backup set. Restoring the database without its matching key cannot recover encrypted plugin credentials. Elowen has no built-in backup/restore command.

SQLite runs with WAL mode, foreign keys, a five-second busy timeout, and automatic migrations at daemon boot. Plugin-owned schemas use the plugin migration API. Start the new daemon after restoring a backup and inspect the logs for migration errors before serving traffic.

## Logs and health

The default files are daily:

```text
~/.config/elowen/logs/daemon-YYYY-MM-DD.log
~/.config/elowen/logs/web-YYYY-MM-DD.log
```

On systemd, the same process output is also available in the journal:

```bash
journalctl -u elowen-daemon -f
journalctl -u elowen-web -f
```

The daemon health probe is public and does not require an account:

```bash
curl -fsS http://127.0.0.1:4400/health
# {"ok":true}
```

## Updating

For a package installation managed by the launcher or installer:

```bash
elowen update
```

The command locates its own npm prefix, installs the latest package, and restarts the managed services when a newer release is available. The database migration runs automatically on the next daemon boot. A plain `npm update -g elowen` does not restart already-running services.

For a source checkout, rebuild the affected artifacts and restart both processes through the service manager:

```bash
npm ci
npm ci --prefix web
npm run build
npm run build:web
sudo systemctl restart --no-block elowen-daemon elowen-web
```

Run the restart as its own command. After the recovered process continues, verify the services separately:

```bash
systemctl is-active elowen-daemon elowen-web
curl -fsS http://127.0.0.1:4400/health
```

Do not expose the daemon directly unless that exposure is deliberate and protected; prefer the web BFF or a reverse proxy for public access.
