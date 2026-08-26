---
title: Docker
slug: docker
order: 3
eyebrow: Start here
group: Start here
---

# Docker

Elowen runs well in a container when you want it isolated from the host or
managed alongside your other services. The image is small — `node:22-alpine`
plus tmux and git — and all persistent state lives in a single SQLite file on a
mounted volume, so upgrades are a container swap, not a migration.

## The image

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
docker build -t elowen .
docker run -d \
  --name elowen \
  -p 4400:4400 \
  -v elowen-data:/app/data \
  -e ELOWEN_DB=/app/data/elowen.db \
  -e ELOWEN_ALLOW_OPEN=1 \
  elowen
```

> tmux is required inside the image for interactive terminal sessions. The `apk add` line above provides that runtime dependency.

## Volumes and environment

Mount the whole Elowen config directory so the SQLite database, `plugin-secrets.key`, plugin data, plans, and attachments survive container recreation. Mounting only the database is insufficient once encrypted plugin credentials exist.

| Variable | Value | Purpose |
|----------|-------|---------|
| `ELOWEN_DB` | `/app/data/elowen.db` | Database path — point it at the mounted volume |
| `ELOWEN_ALLOW_OPEN` | `1` | No-auth mode; only for a container nothing else can reach |
| `ELOWEN_PORT` | `4400` | Daemon listen port inside the container |
| `ELOWEN_BOOTSTRAP_USER` / `ELOWEN_BOOTSTRAP_PASS` | *(empty)* | Seed the first admin on first run |

Leave `ELOWEN_ALLOW_OPEN` off and bootstrap an admin instead when the port is
reachable by anyone but you — see [First-run setup](install#first-run-setup).

## Docker Compose

The same setup as a `compose.yaml`:

```yaml
services:
  elowen:
    build: .
    ports:
      - "4400:4400"
    volumes:
      - elowen-data:/app/data
    environment:
      ELOWEN_DB: /app/data/elowen.db
      ELOWEN_ALLOW_OPEN: "1"
    restart: unless-stopped

volumes:
  elowen-data:
```

Bring it up with `docker compose up -d`.

## Web UI

The image above runs the daemon only. To expose the web UI too, build and run it
alongside the daemon as a second container and publish `4500`, with
`ELOWEN_DAEMON_URL` pointing at the daemon container — the same split the
[manual start](install#manual-start-without-systemd) describes.

## Updating a Docker deployment

The database lives on the volume, so an update is a container swap:

```bash
docker build -t elowen .          # or: docker pull your-registry/elowen
docker stop elowen
docker rm elowen
docker run -d \
  --name elowen \
  -p 4400:4400 \
  -v elowen-data:/app/data \
  -e ELOWEN_DB=/app/data/elowen.db \
  -e ELOWEN_ALLOW_OPEN=1 \
  elowen
```

With Compose it is shorter: `docker compose up -d --build`.

Schema changes are additive and applied at boot, so the new container upgrades
the existing database in place. Back up the volume's database file before a
version jump anyway — the one-liner is in
[Production & Updates](production-updates).

[Next: Production & Updates](production-updates)
