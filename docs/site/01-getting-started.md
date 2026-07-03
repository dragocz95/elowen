---
title: Getting Started
slug: getting-started
order: 1
eyebrow: Start here
---

# Getting Started

**Orcasynth** is a self-hosted daemon that orchestrates autonomous coding agents in
isolated `tmux` sessions — with a REST API, a CLI, and a real-time web UI. This guide
gets you from zero to your first running agent in about two minutes.

## Prerequisites

- **Node.js ≥ 22** — check with `node --version`
- **tmux** — check with `tmux -V` (install via your package manager if missing)

## Install & start

The fastest way to get running:

```bash
npm install -g orcasynth
orca up
```

`orca up` starts the daemon on **`:4400`** and the web UI on **`:4500`** in the
background. Open <http://localhost:4500> and you're greeted by the first-run
onboarding wizard — no login needed until you create the first admin account.

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
  -e ORCA_DB=/app/data/orca.db \
  orca
```

## First-run onboarding

The first time you open the web UI, the onboarding wizard walks you through:

1. **System check** — detects installed agent CLIs (claude, opencode, codex) and tools
   (node, tmux, git).
2. **Provider binaries** — confirms binary paths and extra CLI args per provider.
3. **Autopilot backend** — configure a Relay (API key + URL) or pick CLI Agents for the
   pilot and overseer.
4. **Admin account** — create the first user. After this step you're signed in.
5. **Hermes** — optional MCP-server registration for a same-host Hermes instance.

After onboarding you land on the **Dashboard**, signed in with a secure httpOnly cookie.

## Quickstart: 5 steps to your first agent

1. **Install and start** — `npm install -g orcasynth && orca up`
2. **Open the web UI** — <http://localhost:4500> and complete the onboarding wizard
3. **Configure your LLM** — go to **Settings → Autopilot / Models** and add your provider
   and model
4. **Create a task** — click **New task**, give it a title like "List the files in the
   project root", pick an executor, and hit save
5. **Watch it run** — open **Sessions** to see the agent work live, or open **Tasks** and
   click the task to follow its output

That's it. Your first agent is running.

## Ports & data

| What | Where |
|---|---|
| Daemon REST API + SSE | `:4400` |
| Web UI (Next.js) | `:4500` |
| Config, SQLite DB, logs | `~/.config/orca/` |

## Run from source

For development or to run without a global install:

```bash
# 1. Daemon
npm install
npm run build
ORCA_BOOTSTRAP_USER=admin ORCA_BOOTSTRAP_PASS=changeme node dist/daemon/index.js

# 2. Web UI (separate terminal)
cd web
npm install
npm run build
npm start -- -p 4500
```

The CLI talks to the daemon over the REST API:

```bash
node dist/cli/index.js ls          # list tasks
node dist/cli/index.js close <id>  # close a task
```

## Next steps

- [Concepts](/docs/concepts) — tasks, missions, autonomy levels, the overseer gate
- [CLI](/docs/cli) — every command reference
- [Architecture](/docs/architecture) — modules, timer loops, data flow
- [Install](/docs/install) — detailed install options and troubleshooting
