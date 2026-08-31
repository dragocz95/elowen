---
title: Install
slug: install
order: 2
eyebrow: Start here
group: Start here
---

# Install

This page covers installing Elowen locally, provisioning a server, and building from source. Elowen requires Node.js 22 or newer.

For a container deployment, see [Docker](docker). For an always-on server with service supervision and a reverse proxy, see [Production & Updates](production-updates).

## Supported installation platforms

The bootstrap scripts support:

- **Debian or Ubuntu Linux** — uses `apt`, and provisions systemd services when you run `elowen install`.
- **macOS** — uses Homebrew where needed and provisions per-user `launchd` agents. Run it as your normal user, not with `sudo`.
- **Windows through WSL2** — native Windows is not supported. The PowerShell bootstrap installs or uses Ubuntu in WSL2 and runs the Linux installer there.

`elowen install` currently requires `apt` on Linux. On another Linux distribution, install Node.js, npm, and the required runtime tools yourself and use the local or source workflow instead of assuming the server provisioner supports that distribution.

## Requirements

- Node.js 22 or newer.
- npm.
- `tmux` for interactive terminal sessions and integrations that launch external command-line tools. Local `setup` warns when it is missing; server `install` can install it.
- Git for Git Projects and Sandbox workspaces.
- On Linux, `bubblewrap` for the Sandbox's confined non-operator execution. Server installation can install it.
- A C compiler and Python 3 are useful when the optional `node-pty` dependency must compile locally. If live PTY streaming cannot be installed, Elowen keeps the terminal snapshot fallback.

## Bootstrap installation

On Debian/Ubuntu or macOS, the bootstrap installs Node.js when necessary, installs the global npm package, and then hands off to `elowen install`:

```bash
curl -fsSL https://raw.githubusercontent.com/dragocz95/elowen/main/install.sh | bash
```

The script is network code executed by your shell. Inspect it first if required by your operational policy. You can pass installer flags directly, or use `ELOWEN_INSTALL_ARGS`:

```bash
ELOWEN_INSTALL_ARGS='--unattended --localhost --admin-user admin --admin-pass CHANGE_ME' \
bash install.sh
```

To pin a package version:

```bash
ELOWEN_VERSION=0.28.13 bash install.sh
```

On Windows, run PowerShell as Administrator:

```powershell
irm https://raw.githubusercontent.com/dragocz95/elowen/main/install.ps1 | iex
```

The first WSL installation may require a Windows reboot. Re-run the command after the reboot.

## Global npm installation

If Node.js 22 or newer is already installed, install the package directly:

```bash
npm install -g elowen
elowen setup
```

`elowen setup` starts or adopts the local daemon and runs the onboarding wizard. It configures the first account, an optional Project, an AI provider and model, optional embeddings, and optional TypeScript language-server support.

The setup wizard can be re-run. In a non-interactive terminal it does not prompt; use `--non-interactive` with the required flags instead.

## CLI lifecycle

```bash
elowen             # open the interactive terminal chat
elowen chat        # open a new conversation
elowen run "..."   # run one non-interactive turn and exit
elowen -p "..."   # alias for run
elowen menu        # interactive service launcher
elowen up          # start local daemon and web UI
elowen down        # stop them; waits for running work
elowen down --force # stop immediately
elowen status      # show service state and health
elowen restart all # safely queue a daemon + web restart
elowen doctor      # readiness checks and remediation hints
elowen update      # install the latest release and restart
```

Use `elowen login` when a CLI session needs an explicitly cached login token. A normal authenticated request uses a bearer token; do not put the token in a query string.

## Unattended setup

Use secrets from environment variables rather than putting them in shell history where possible:

```bash
ELOWEN_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
ELOWEN_API_KEY="$OPENAI_API_KEY" \
elowen setup --non-interactive \
  --admin-user admin \
  --project "$PWD" \
  --provider openai \
  --model gpt-4o-mini \
  --memory skip
```

Useful flags include:

- `--admin-user` and `--admin-password` (or `ELOWEN_ADMIN_USER` and `ELOWEN_ADMIN_PASSWORD`).
- `--project PATH`, `--project-slug SLUG`, or `--no-project`.
- `--provider PRESET|custom`, `--api-key`, `--base-url`, and `--model`.
- `--memory reuse|openrouter|skip`, `--memory-key`, and `--embedding-model`.
- `--lsp` to install the TypeScript language server.
- `--skip-test` to skip the provider chat smoke-test.

`custom` providers require `--base-url`. If an existing installation already has an administrator, pass the administrator password to authenticate before changing configuration. Run `elowen doctor` after scripted setup to inspect the resulting readiness matrix.

## Server provisioning with `elowen install`

Use the provisioner for an always-on machine:

```bash
sudo elowen install
```

On Linux it can create or reuse a service user, install `tmux` and Sandbox support, configure systemd units, configure nginx or Apache for a domain, and optionally request a Let’s Encrypt certificate. It also creates the web and daemon services and an hourly update timer. On macOS, run `elowen install` without `sudo`; it creates per-user launchd agents and stays localhost-only.

The interactive installer shows a plan before making system changes. For a non-interactive Linux install, the main deployment choices are:

```bash
sudo elowen install --unattended \
  --localhost \
  --admin-user admin \
  --admin-pass "$ADMIN_PASSWORD"
```

For a domain, use `--domain example.com`; for direct IP access use `--ip ADDRESS` or `--host ADDRESS`. See `elowen install --help` for all options, including `--proxy nginx|apache`, `--email`, `--user`, and `--no-tmux`.

## Build from source

The daemon and web application have separate build steps. From a checkout:

```bash
git clone https://github.com/dragocz95/elowen.git
cd elowen
npm install
npm run build
npm install --prefix web
npm run build:web
```

Start the daemon in one terminal:

```bash
ELOWEN_DB="$HOME/.config/elowen/elowen.db" \
node dist/daemon/index.js
```

Start the standalone web server in another:

```bash
PORT=4500 \
HOSTNAME=127.0.0.1 \
ELOWEN_DAEMON_URL=http://127.0.0.1:4400 \
node web-dist/server.js
```

`npm run build` builds the TypeScript daemon and bundled plugin assets; it does not build the web UI. `npm run build:web` creates `web-dist/server.js` and copies the standalone server's static and public assets.

## Ports and environment

The daemon defaults to `127.0.0.1:4400`. The web server defaults to port `4500` only when launched by Elowen's installer or launcher; a standalone Next server uses the standard `PORT` and `HOSTNAME` variables.

Common variables are:

```text
ELOWEN_PORT=4400
ELOWEN_HOST=127.0.0.1
ELOWEN_DB=~/.config/elowen/elowen.db
ELOWEN_LOG_DIR=~/.config/elowen/logs
ELOWEN_PROJECT=elowen
ELOWEN_PROJECT_PATH=$PWD
ELOWEN_BOOTSTRAP_USER=
ELOWEN_BOOTSTRAP_PASS=
ELOWEN_DAEMON_URL=http://localhost:4400
ELOWEN_URL=http://localhost:4400
ELOWEN_TOKEN=
ELOWEN_AUTOSTART=1
```

`ELOWEN_WEB_PORT` is an installer/launcher setting. When starting `web-dist/server.js` yourself, set `PORT` explicitly.

## Persistent state

By default, Elowen stores its state under `~/.config/elowen/`:

- `elowen.db` — SQLite database.
- `plugin-secrets.key` — required to decrypt encrypted plugin credentials.
- `logs/` — daemon and web logs.
- `plans/`, `tool-results/`, `chat-images/`, plugin data, and other runtime directories.

Override the database with `ELOWEN_DB` and logs with `ELOWEN_LOG_DIR`. Back up the whole configuration directory when possible; backing up only the database does not preserve plugin secrets or adjacent runtime data.

## Authentication on a new install

Before the first user exists, the daemon allows the setup flow to create an administrator. You can also seed the first administrator with `ELOWEN_BOOTSTRAP_USER` and `ELOWEN_BOOTSTRAP_PASS` when starting the daemon.

Once a user exists, normal requests require authentication. `ELOWEN_ALLOW_OPEN=1` is not a supported runtime switch for disabling authentication; do not use it as a security control.

[Next: Docker](docker)
