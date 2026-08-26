---
title: Production & Updates
slug: production-updates
order: 4
eyebrow: Start here
group: Start here
---

# Production & Updates

Running Elowen on your own server — an always-on box you reach over the network
— adds a few operational concerns on top of a local install: service
supervision, a reverse proxy with HTTPS, monitoring, backups, and updates. Most
of it is set up for you by the installer; the rest of this page is reference for
running the pieces by hand.

## What `elowen install` provisions

For a shared or always-on box, `elowen install` provisions the whole service.
It's a separate, heavier wizard than `elowen setup` — run it **as root**:

```bash
sudo elowen install
```

It will:

1. Install prerequisites (tmux) and, optionally, the coding-agent CLIs it
   detects — Claude Code, OpenCode, Codex
2. Create (or reuse) a dedicated **service user** to run the agents
3. Ask how you'll reach the UI — a **domain** (nginx or Apache reverse proxy +
   free Let's Encrypt HTTPS), the server's **IP on a port**, or **localhost
   only**. The generated vhost also routes `/hooks/` to the daemon so plugin
   inbound webhooks work out of the box
4. Write and enable the systemd units — `elowen-daemon` (`:4400`) and
   `elowen-web` (`:4500`) — plus the `elowen-update.timer` and a **sudoers
   drop-in** for self-updates (see [Auto-update](#auto-update))
5. Run the same onboarding as `elowen setup` to create the admin, connect a
   project, and wire the AI provider

Add `--unattended` with flags (`--domain`, `--ip`, `--localhost`,
`--admin-user`, `--admin-pass`, `--agents`, …) for a hands-off provision; run
`elowen install --help` for the full list. Manage the box afterwards with
`elowen menu`, which drives the systemd units directly.

## systemd services

If you run the units by hand instead of using the installer,
`/etc/systemd/system/elowen-daemon.service`:

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

`/etc/systemd/system/elowen-web.service` alongside it:

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
```

## Reverse proxy (nginx)

```nginx
server {
    listen 443 ssl;
    server_name elowen.example.com;

    location / {
        proxy_pass http://127.0.0.1:4500;
        proxy_http_version 1.1;
    }

    # Daemon API + SSE (BFF proxy via Next.js)
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

    # Real-PTY WebSocket terminal (straight to daemon)
    location /ws/ {
        proxy_pass http://127.0.0.1:4400;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400s;
        proxy_set_header x-real-ip $remote_addr;
    }

    # Plugin webhooks (e.g. Teams bot endpoint)
    location /hooks/ {
        proxy_pass http://127.0.0.1:4400;
        proxy_http_version 1.1;
        proxy_set_header x-real-ip $remote_addr;
    }

    # Service worker — never cache
    location = /sw.js {
        proxy_pass http://127.0.0.1:4500;
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
    }
}
```

Why each location matters:

| Location | Reason |
|----------|--------|
| `/api/` | `proxy_buffering off` + long timeout keep SSE streams flowing without nginx swallowing events. |
| `/ws/` | WebSocket upgrade for the real-PTY terminal; without it, terminals fall back to snapshot mirror. |
| `/hooks/` | Plugin inbound webhooks (e.g. Teams Bot Framework). Auth handled by the plugin, not the daemon token. |
| `/sw.js` | Prevents a cached service worker from serving stale UI after deploys. |

> Set `x-real-ip` on every proxied location. The daemon uses it for login rate
> limiting; without it, all users share one bucket behind the proxy.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ELOWEN_PORT` | `4400` | Daemon listen port |
| `ELOWEN_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` to expose) |
| `ELOWEN_DB` | `~/.config/elowen/elowen.db` | SQLite database path |
| `ELOWEN_PROJECT` | `elowen` | Initial project slug |
| `ELOWEN_PROJECT_PATH` | `$PWD` | Default project root |
| `ELOWEN_ALLOW_OPEN` | *(empty)* | Set `1` for no-auth mode |
| `ELOWEN_BOOTSTRAP_USER` / `PASS` | *(empty)* | Initial admin credentials |
| `ELOWEN_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `ELOWEN_LOG_DIR` | `~/.config/elowen/logs` | File-based log directory |
| `ELOWEN_WEB_PORT` | `4500` | Web UI port |
| `ELOWEN_DAEMON_URL` | `http://localhost:4400` | Web UI to daemon URL |
| `ELOWEN_URL` | `http://localhost:4400` | Daemon URL used by CLI clients |
| `ELOWEN_TOKEN` | *(empty)* | Auth token for non-interactive CLI/API calls |
| `ELOWEN_AUTOSTART` | `1` | Set `0` to stop CLI commands from auto-starting a daemon |
| `ELOWEN_CLI` | `elowen` | CLI command used for spawned workers |

## Updating

```bash
elowen update
```

Pulls the latest release and restarts in place. Self-locating: it computes the
npm prefix from its own binary path and handles root-owned installs via sudo.

### Auto-update

`elowen install` adds the `elowen-update.timer`, which fires an `elowen update
--auto` check hourly (and once ~15 minutes after boot). It's **off by default** —
the timer runs but the update no-ops until you turn auto-update on in **Settings →
System**. Once enabled, updates use the daemon's guarded drain/restart path, so admitted work is allowed to settle before the service exits.

So the timer can go live unattended, the installer also writes a **sudoers
drop-in** (`/etc/sudoers.d/elowen`, validated with `visudo`) granting the service
user a narrow set of passwordless commands: restart and query its own units, and
run the pinned self-reinstall. Without it the services still run — only in-place
self-updates lose the ability to restart the units on their own.

## Monitoring & logs

```bash
curl http://localhost:4400/health   # {"ok":true}

journalctl -u elowen-daemon -f                        # systemd journal
tail -f ~/.config/elowen/logs/daemon-$(date +%F).log  # daily file logs
```

Log files are daily (`daemon-2026-07-26.log`); there is no rolling file.
Settings → Data → Logs in the web UI reads the same directory.

## Database

SQLite with WAL mode, one file at `~/.config/elowen/elowen.db` by default. Back
up with:

```bash
sqlite3 /path/to/elowen.db ".backup /backup/elowen-$(date +%Y%m%d).db"
```

Schema changes are additive (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE`)
applied at boot. No migration framework — back up before updating.

[Next: Web UI](web-ui)
