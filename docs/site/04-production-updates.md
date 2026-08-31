---
title: Production & Updates
slug: production-updates
order: 4
eyebrow: Operate safely
group: Start here
---

# Production & Updates

Use `elowen install` for an always-on machine. It provisions the service processes, persistent runtime directories, and—on Linux—a systemd-managed deployment. Put HTTPS and any public hostname in front of the web UI; keep the daemon private unless you deliberately choose direct IP mode.

## Provision a server

On Debian or Ubuntu Linux, run the installer as root:

```bash
sudo elowen install
```

The interactive installer lets you choose:

- a new or existing service user;
- localhost-only access, direct access on the server IP, or a domain;
- nginx or Apache when a domain is used; and
- whether to request a Let’s Encrypt certificate.

It installs missing `tmux`, Linux Sandbox support, and optional terminal streaming support where possible. It then writes and starts the daemon and web services, waits for the daemon health endpoint, configures the selected proxy, and runs onboarding for the first administrator.

For a non-interactive localhost deployment:

```bash
sudo elowen install --unattended \
  --localhost \
  --admin-user admin \
  --admin-pass "$ADMIN_PASSWORD"
```

For a public deployment, replace `--localhost` with `--domain example.com` or `--ip ADDRESS`. Use `elowen install --help` for `--proxy nginx|apache`, `--email`, `--user`, `--no-tmux`, and the optional model flags.

On macOS, run the command as the logged-in user, without `sudo`:

```bash
elowen install
```

macOS uses per-user launchd agents and remains localhost-only. Native Windows is not supported; use the WSL2 bootstrap described in [Install](install#bootstrap-installation).

## Services and lifecycle

Linux installs create:

- `/etc/systemd/system/elowen-daemon.service`
- `/etc/systemd/system/elowen-web.service`
- `/etc/systemd/system/elowen-update.service`
- `/etc/systemd/system/elowen-update.timer`

The generated daemon unit runs `dist/daemon/index.js`; the web unit runs `web-dist/server.js`. The exact package paths, service user, ports, environment, drain timeout, and `KillMode=mixed` are generated for the installation. Prefer re-running the installer or inspecting the generated units over copying an old unit file from documentation.

Useful commands:

```bash
sudo systemctl status elowen-daemon elowen-web
elowen restart all
sudo systemctl stop elowen-daemon elowen-web
sudo systemctl enable elowen-daemon elowen-web
```

A daemon restart drains active turns and delegated work before exiting. A normal stop can therefore take time. Use `systemctl kill` only as an emergency intervention when you accept that in-flight work may be interrupted.

On macOS, inspect and restart the per-user agents with:

```bash
launchctl print gui/$(id -u)/io.elowen.daemon
launchctl kickstart -k gui/$(id -u)/io.elowen.daemon
```

## Reverse proxy

For a domain deployment, the installer configures nginx or Apache. If you maintain the proxy yourself, route these paths:

- `/` to the web UI on `127.0.0.1:4500`;
- `/ws/` to the daemon on `127.0.0.1:4400`, with WebSocket upgrade support; and
- `/hooks/` to the daemon on `127.0.0.1:4400`.

For nginx, the important shape is:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name elowen.example.com;

    location /ws/ {
        proxy_pass http://127.0.0.1:4400;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }

    location /hooks/ {
        proxy_pass http://127.0.0.1:4400;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location = /sw.js {
        proxy_pass http://127.0.0.1:4500;
        proxy_set_header Host $host;
        proxy_hide_header Cache-Control;
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
    }

    location / {
        proxy_pass http://127.0.0.1:4500;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

`X-Real-IP` must be overwritten by the trusted proxy, not copied from an incoming client header. Elowen uses it for rate limiting and request-origin handling. Keep `/ws/` and `/hooks/` ahead of the catch-all location.

The installer can obtain HTTPS with Certbot for a domain. An IP deployment is HTTP-only and binds the web and daemon to `0.0.0.0`; open the required ports in the firewall and understand that this exposes the daemon's listener as well as the web UI.

## Runtime configuration

The daemon defaults are:

| Variable | Default | Use |
|---|---|---|
| `ELOWEN_PORT` | `4400` | Daemon port |
| `ELOWEN_HOST` | `127.0.0.1` | Daemon bind address |
| `ELOWEN_DB` | `~/.config/elowen/elowen.db` | SQLite database path |
| `ELOWEN_LOG_DIR` | `~/.config/elowen/logs` | File log directory |
| `ELOWEN_PROJECT` | `elowen` | Initial project slug |
| `ELOWEN_PROJECT_PATH` | current working directory | Initial project path |
| `ELOWEN_BOOTSTRAP_USER` | empty | First-admin username |
| `ELOWEN_BOOTSTRAP_PASS` | empty | First-admin password |
| `ELOWEN_DAEMON_URL` | `http://localhost:4400` | Web server's daemon URL |
| `ELOWEN_URL` | `http://localhost:4400` | CLI daemon URL |
| `ELOWEN_TOKEN` | empty | Explicit CLI/API bearer token |
| `ELOWEN_AUTOSTART` | `1` | Set to `0` to disable CLI auto-start |

The standalone web server uses `PORT` and `HOSTNAME`, not `ELOWEN_WEB_PORT`. The installer and launcher use `ELOWEN_WEB_PORT` when choosing the web port and write the resulting `PORT` into the generated web service.

Do not use `ELOWEN_ALLOW_OPEN=1` as an authentication control. It is not a supported runtime switch. The daemon is open only while no user exists, so the first-run flow can create the first administrator; after that, normal requests require authentication.

## Logs and health checks

The daemon health probe is public and does not require a token:

```bash
curl -fsS http://127.0.0.1:4400/health
```

On systemd installations:

```bash
sudo journalctl -u elowen-daemon -f
sudo journalctl -u elowen-web -f
```

File logs are written daily by default:

```text
~/.config/elowen/logs/daemon-YYYY-MM-DD.log
~/.config/elowen/logs/web-YYYY-MM-DD.log
```

The web UI also exposes the same logs under **Settings → Data → Logs**.

## Updates

For a normal global installation:

```bash
elowen update
```

This checks npm, installs `elowen@latest` into the prefix containing the current CLI, and restarts the running services. A plain `npm update -g elowen` does not restart already-running daemon or web processes.

On a systemd installation, the generated update service uses the service user and the matching database. The installer also creates `elowen-update.timer`:

- first check: 15 minutes after boot;
- later checks: hourly;
- missed checks are persistent across boot;
- each check is a no-op until automatic updates are enabled.

Enable automatic updates in **Settings → System**. The installer writes a narrowly scoped `/etc/sudoers.d/elowen` entry so the service user can restart the Elowen units and run the pinned self-reinstall command. If that step fails, the services still work, but unattended in-place updates cannot restart them until the permission is repaired.

The web update action is asynchronous: it queues the update and returns before the daemon restart completes. Verify the service and health status after an update:

```bash
sudo systemctl is-active elowen-daemon elowen-web
curl -fsS http://127.0.0.1:4400/health
```

## Backups and migrations

SQLite uses WAL mode and migrations run automatically when the daemon boots. There is no built-in Elowen backup or restore command.

Back up the complete configuration directory when possible. At minimum, retain the database and its matching encryption key together:

```bash
sqlite3 "$HOME/.config/elowen/elowen.db" \
  ".backup $HOME/backup/elowen-$(date +%Y%m%d).db"
cp "$HOME/.config/elowen/plugin-secrets.key" "$HOME/backup/"
```

The `sqlite3` executable is not an Elowen prerequisite. A full configuration backup also preserves plugin data, plans, attachments, OAuth credentials, provider secrets, and logs. Stop or quiesce the service before a filesystem-level copy; the SQLite `.backup` command is the safer option while the database is active.

Before a version jump, keep a recoverable backup and allow the new daemon to complete its boot migrations. If the new version cannot start, inspect the journal before attempting another update; do not delete migration or lock files as a workaround.

[Next: Web UI](web-ui)
