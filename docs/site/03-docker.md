---
title: Docker
slug: docker
order: 3
eyebrow: Start here
group: Start here
---

# Docker

The repository does not ship a production `Dockerfile` or `compose.yaml`. The `scripts/install-smoke/Dockerfile` is a CI test image, not a release image. The installer-managed production path is native daemon and web processes under systemd (or launchd on macOS); Docker is a bring-your-own alternative. If you deploy with Docker, build an image from the source checkout or from the published package and keep the complete Elowen configuration directory persistent.

The example below builds both the daemon and the standalone web bundle in one image. Review it and adapt the base image, user, registry, and hardening policy to your environment.

## Build an image from source

Create a local `Dockerfile` in the repository root:

```dockerfile
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux git ca-certificates bubblewrap \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the checkout before installing: this example does not assume a .dockerignore file,
# and the web package uses a local workspace dependency.
COPY . .
RUN npm ci \
 && npm ci --prefix web \
 && npm run build \
 && npm run build:web

RUN useradd --create-home --shell /bin/bash elowen \
 && mkdir -p /home/elowen/.config/elowen \
 && chown -R elowen:elowen /home/elowen/.config/elowen

USER elowen
ENV HOME=/home/elowen
WORKDIR /app

EXPOSE 4400 4500
CMD ["node", "dist/daemon/index.js"]
```

Build it:

```bash
docker build -t elowen:local .
```

The image runs the daemon by default. The web process is a separate process and should run in a second container or under a process supervisor.

## Run the daemon and web UI with Compose

This example uses Docker's internal network for daemon-to-web traffic and publishes only the Web UI. Keep the daemon port internal to the Compose network; the Web UI's BFF reaches it through `http://daemon:4400`. The daemon is still authenticated.

```yaml
services:
  daemon:
    image: elowen:local
    command: ["node", "dist/daemon/index.js"]
    environment:
      ELOWEN_DB: /home/elowen/.config/elowen/elowen.db
      ELOWEN_HOST: 0.0.0.0
      ELOWEN_PORT: "4400"
      ELOWEN_PROJECT_PATH: /workspace/project
    volumes:
      - elowen-config:/home/elowen/.config/elowen
      - ./:/workspace/project
    expose:
      - "4400"
    restart: unless-stopped

  web:
    image: elowen:local
    command: ["node", "web-dist/server.js"]
    depends_on:
      - daemon
    environment:
      PORT: "4500"
      HOSTNAME: 0.0.0.0
      ELOWEN_DAEMON_URL: http://daemon:4400
    ports:
      - "4500:4500"
    restart: unless-stopped

volumes:
  elowen-config:
```

Start it:

```bash
docker compose up -d
```

Open <http://localhost:4500>. The first-run flow is available while the configuration volume contains no users. To configure it from the container, run the bundled CLI entrypoint against the daemon:

```bash
docker compose exec daemon node dist/cli/bin.js setup
```

For scripted setup, use `elowen setup --non-interactive` and pass the administrator password and provider secrets through environment variables rather than command-line arguments. See [Install](install#unattended-setup).

## Persistent storage

Persist the whole Elowen configuration directory, not just `elowen.db`. It contains:

- `elowen.db` and its SQLite runtime files.
- `plugin-secrets.key`, which is required to decrypt encrypted plugin credentials.
- Plugin data and configuration.
- Plans, attachments, chat images, tool-result spills, logs, and other runtime state.

A container recreated without the matching configuration directory and secret key cannot recover encrypted plugin credentials. Back up the volume before upgrades; see [Production & Updates](production-updates#backups-and-migrations).

Mount each Project that an account may use at a stable path and register that path in Elowen. A container path such as `/workspace/project` is not interchangeable with the host path used outside the container.

## Authentication and network exposure

There is no supported general-purpose no-auth switch. Authentication is open only while the database has no users, so the first administrator can be created.

For a public deployment, prefer:

- publishing the web UI through HTTPS;
- keeping the daemon private behind the web BFF or a reverse proxy; and
- routing `/hooks/` directly to the daemon when an inbound plugin webhook is used.

The [Production & Updates](production-updates) page contains the reverse-proxy locations and header requirements.

## Updating containers

Build a new image and recreate the services:

```bash
docker compose build
docker compose up -d
```

Elowen runs database migrations automatically when the new daemon boots. Keep a backup of the configuration volume before a version change. A plain image replacement does not migrate data until the new daemon starts.
