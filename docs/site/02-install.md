---
title: Install
slug: install
order: 2
eyebrow: Getting started
---

# Install

Orca runs as a self-hosted daemon plus a Next.js web UI. You need:

- **Node.js** ≥22 (ESM)
- **tmux** ≥3.x
- **npm**
- A C toolchain for `node-pty` (optional — `python3`, `make`, `g++`; terminals
  degrade gracefully without it)

## npm global (recommended)

```bash
npm install -g orcasynth
orca install        # guided setup wizard
```

The install wizard provisions system dependencies, configures providers,
creates the first user, and sets up systemd units.

### Manual start (without systemd)

```bash
orca up
```

Or run the daemon directly:

```bash
ORCA_PORT=4400 \
ORCA_DB=$HOME/.config/orca/orca.db \
ORCA_ALLOW_OPEN=1 \
node dist/daemon/index.js
```

## Docker

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

Build and run:

```bash
docker build -t orca .
docker run -d \
  --name orca \
  -p 4400:4400 \
  -v orca-data:/app/data \
  -e ORCA_DB=/app/data/orca.db \
  -e ORCA_ALLOW_OPEN=1 \
  orca
```

## Build from source

```bash
git clone https://github.com/dragocz1995/orcasynth.git
cd orcasynth
npm install
npm run build
```

Then start the daemon:

```bash
node dist/daemon/index.js
```

And the web UI (separate terminal):

```bash
cd web
npm install
npm run build
npm start    # serves on port 3000
```

## Ports & services

| Service | Default port | Purpose |
|---------|-------------|---------|
| Daemon API | `4400` | REST API, SSE events, MCP, WebSocket terminal |
| Web UI | `4500` | Next.js frontend (BFF proxy to daemon) |

Override with `ORCA_PORT` and `ORCA_WEB_PORT`.

## Data directory

The daemon stores its SQLite database at `~/.config/orca/orca.db` by default.
Override with `ORCA_DB`. The database is created automatically on first run
(schema from `dist/store/schema.sql`).

## First run setup

When you start the daemon for the first time with `ORCA_ALLOW_OPEN=1`, you can
use it without authentication. For a production setup, provide credentials:

```bash
ORCA_BOOTSTRAP_USER=admin \
ORCA_BOOTSTRAP_PASS=secure-pass \
node dist/daemon/index.js
```

The admin user is seeded once. If you skip bootstrap vars, the daemon logs a
warning and login won't be possible until you create a user via the API.

## Auto-update

`orca install` sets up a systemd timer that checks for new versions hourly.
The update respects running missions — it won't restart while a mission is
active. Toggle auto-update in Settings → System.

[Next: Tasks & Missions](tasks-missions)
