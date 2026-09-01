# Deployment

This page covers building Elowen from a checkout, running its two processes, and provisioning a machine for service-managed operation.

## Supported installation paths

The default machine provisioner is `elowen install`:

- **Debian or Ubuntu:** run it as root (`sudo elowen install`). It creates a dedicated service user, two systemd services, and an hourly update timer.
- **macOS:** run it as the current user, without `sudo`. It creates per-user LaunchAgents and binds to localhost.
- **Windows:** run Elowen inside WSL2. Native Windows is not supported because the runtime uses Linux tooling such as tmux and systemd.

The Linux provisioner requires `apt`; the macOS provisioner requires Homebrew when it must install tmux. Node.js 22 or newer is required on every platform.

For a packaged installation with Node.js already installed:

```bash
npm install -g elowen
elowen install
```

This installs the version currently published to npm. A source checkout may report a newer package version before that release is published; do not use `npm install -g elowen` as a way to install an unpublished checkout. Use `elowen install --help` for unattended installation flags, service-user selection, deployment mode, reverse-proxy selection, and first-admin/model setup. The one-line installers in the repository perform the same package installation and then invoke `elowen install`.

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

## Docker

Elowen's native production shape is two supervised host processes, normally systemd on Linux, with SQLite and plugin data on a local persistent disk and a reverse proxy in front of the Web UI. The repository does not ship a production `Dockerfile` or `compose.yaml`; `scripts/install-smoke/Dockerfile` is a CI test image. Docker is therefore a bring-your-own packaging option, not the installer-managed deployment path. Build an image from this checkout (or from a published package) and run the daemon and standalone web server as separate processes, preferably in separate containers or under a process supervisor.

The image must contain Node.js 22 or newer, `tmux`, `git`, `ca-certificates`, and `bubblewrap`. A minimal source-build sequence is:

```dockerfile
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends tmux git ca-certificates bubblewrap \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN npm ci && npm ci --prefix web && npm run build && npm run build:web
CMD ["node", "dist/daemon/index.js"]
```

Run `node web-dist/server.js` separately with `PORT`, `HOSTNAME`, and `ELOWEN_DAEMON_URL` set. Persist the complete `~/.config/elowen` directory, including `elowen.db`, SQLite sidecar files, `plugin-secrets.key`, plugin data, attachments, and logs. When the web container is separate, point `ELOWEN_DAEMON_URL` at the daemon's internal service name; publish the web port and keep daemon port `4400` private unless direct daemon API access is intentional and protected.

For a container update, build the new image with both artifacts first, then recreate the daemon and web processes from that same image. The daemon applies database migrations on boot. Back up the configuration volume before changing versions and verify both health endpoints after recreation.

## Runtime configuration

The persistent default state directory is `~/.config/elowen`. `ELOWEN_DB` changes only the database path; `ELOWEN_LOG_DIR` changes the log directory.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ELOWEN_PORT` | `4400` | Daemon HTTP port. |
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

The web server itself reads the standard `PORT` and `HOSTNAME` variables. `ELOWEN_WEB_PORT` is an installer/launcher setting; it is not read by the Next.js server.

There is no supported general-purpose no-auth switch. Authentication is open only during the initial zero-user setup flow; after the first user exists, normal requests require a bearer token or the authenticated web session.

## Registry plugins and compatibility

Registry plugins are installed by copying their files from the curated `https://github.com/dragocz95/elowen-plugins` repository; they are not installed with a second npm dependency tree. The daemon links each installed plugin to its own `node_modules`, so the plugin uses the host daemon's packages.

Before installation, Elowen validates the plugin manifest:

- `requiresCore` is a minimum Elowen version. Upgrade the daemon first when a plugin requires a newer core.
- `requiresSharedApi` must exactly match the `elowen-plugin-shared` API major shipped by the daemon.
- `apiVersion` must match the daemon's plugin contract version.

Keep the core and registry plugin release compatible. If the registry is unavailable, the last good local cache may still serve installed plugins; a plugin update is not applied until its manifest validates and the rebuilt registry loads it.

## Custom source deployments

A source-managed production host may keep a complete built checkout at a stable application path, keep the database/logs/Projects on a separate persistent local path, and run `dist/daemon/index.js` plus `web-dist/server.js` as native systemd services behind nginx. Build both artifacts before transfer; on a small production VM it is usually safer to build on a development or CI machine and copy the completed tree than to make `next build` compete with live traffic. Preserve absolute Project paths and the data directory across releases, and keep ports `4400` and `4500` bound to loopback when nginx is the public edge.

This custom layout is operationally valid but is not generated or updated by `elowen install`; its unit files, artifact transfer, backups, and rollback procedure belong to the deployment owner. Do not describe such a checkout as the npm-published package version until that package has actually been published.

## Service-managed deployment

The installer writes these Linux units:

- `elowen-daemon.service`
- `elowen-web.service`
- `elowen-update.service`
- `elowen-update.timer`

The daemon unit runs the compiled `dist/daemon/index.js`; the web unit runs `web-dist/server.js`. Both run as the selected unprivileged service user. The web unit starts after the daemon and has a short stop timeout because `build:web` injects a SIGTERM handler into the standalone Next.js server.

On daemon stop or restart, new turns are refused and active work drains at a step boundary when it can be resumed on the next boot; work stuck mid-step is waited for up to ten minutes. The daemon exits with status 75 for an intentional restart, which systemd treats as a restart. `KillMode=mixed` lets forked sub-agent runners finish during the daemon drain, and `TimeoutStopSec=660` is deliberately longer than the ten-minute drain. Use `elowen down --force` only when you explicitly accept losing in-flight work.

The update timer starts 15 minutes after boot and checks hourly (`Persistent=true` also catches a missed run after downtime). The timer is enabled by the installer, but `elowen update --auto` is a no-op until auto-update is enabled in Elowen settings. It installs `elowen@latest` into the active npm prefix, then queues one non-blocking restart of both units.

Check both service state and readiness after installation or restart:

```bash
sudo systemctl is-active elowen-daemon elowen-web
sudo systemctl is-active elowen-update.timer
curl -fsS http://127.0.0.1:4400/health
curl -fsS http://127.0.0.1:4500/
```

`systemctl is-active` only proves that processes are running; the daemon `/health` probe must return HTTP 200 with `ok: true`, and the web root must also return HTTP 200. In direct-IP mode, use the configured public web and daemon addresses instead of `127.0.0.1`.

On macOS, use the LaunchAgents created by `elowen install`; the service logs remain under `~/.config/elowen/logs/`.

## Reverse proxy

When a reverse proxy fronts the web UI, route browser traffic to the web process and plugin webhooks directly to the daemon:

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

`proxy_buffering off` and a long `proxy_read_timeout` are required for SSE. The `/hooks/` route is authenticated by the receiving plugin, not by the daemon bearer-token middleware. Forward `x-real-ip` from the trusted proxy so the daemon can apply its configured client-IP policy and login rate limits.

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

The daemon health probe is public and does not require an account. It returns `ok: true`, the running version, and runtime diagnostics such as event-loop and sub-agent-pool state:

```bash
curl -fsS http://127.0.0.1:4400/health
# includes {"ok":true,"version":"<running version>",...}
curl -fsS http://127.0.0.1:4500/
```

Require HTTP 200 from both probes. The web root is the readiness check for the standalone Next.js process; `/health` alone does not prove that the web UI is serving.

## Updating

For a package installation managed by the launcher or installer:

```bash
elowen update
```

The command locates its own npm prefix, installs `elowen@latest`, and queues one non-blocking restart of both managed services when a newer release is available. The database migration runs automatically on the next daemon boot. A plain `npm update -g elowen` does not restart already-running services and is not a complete managed update.

For a source checkout, build both artifacts completely before restarting either process. `npm run build` builds the daemon, CLI, bundled plugins, and plugin web bundles into `dist/`; `npm run build:web` separately builds the Next.js standalone server and assembles `web-dist/` with its static and public assets. Do not restart after only the daemon build, or the web service will continue to use the previous `web-dist/`.

```bash
npm ci
npm ci --prefix web
npm run build
npm run build:web
elowen restart all
```

Run the restart as its own command. It is non-blocking so the daemon can drain active work without waiting for systemd from inside its own process group. Wait for the recovered processes, then verify them in a separate command:

```bash
systemctl is-active elowen-daemon elowen-web
curl -fsS http://127.0.0.1:4400/health
curl -fsS http://127.0.0.1:4500/
```

If a restart fails, inspect `journalctl -u elowen-daemon` and `journalctl -u elowen-web`; do not fall back to a blocking `systemctl restart` from a web-triggered or daemon-running update.

Do not expose the daemon directly unless that exposure is deliberate and protected; prefer the web BFF or a reverse proxy for public access.
