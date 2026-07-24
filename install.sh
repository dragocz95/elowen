#!/usr/bin/env bash
#
# Elowen bootstrap installer for Debian/Ubuntu and macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/dragocz95/elowen/main/install.sh | bash
#
# This script does ONLY what `elowen install` cannot do itself, because it has to run
# *before* Elowen exists on the machine: ensure a modern Node.js and the global `elowen`
# package. Everything else — tmux, the services (systemd units on Linux, per-user launchd
# agents on macOS), the reverse proxy (Linux) and the first admin — is delegated to
# `elowen install`, the project's own tested provisioner.
#
# Linux runs privileged (sudo) and provisions a dedicated service user; macOS runs entirely
# as the invoking user (Homebrew and launchd gui agents both refuse root).
#
# Environment overrides:
#   ELOWEN_VERSION        install a specific npm version (e.g. 0.27.3). Default: latest.
#   ELOWEN_INSTALL_ARGS   extra flags forwarded to `elowen install`
#                         (e.g. "--unattended --localhost --admin-user admin --admin-pass s3cret").
#
set -euo pipefail

readonly MIN_NODE_MAJOR=22
readonly NODESOURCE_SETUP="https://deb.nodesource.com/setup_22.x"

# ── output helpers ───────────────────────────────────────────────────────────
if [ -t 1 ]; then
  c_reset=$'\033[0m'; c_bold=$'\033[1m'; c_blue=$'\033[34m'; c_green=$'\033[32m'; c_red=$'\033[31m'; c_yellow=$'\033[33m'
else
  c_reset=''; c_bold=''; c_blue=''; c_green=''; c_red=''; c_yellow=''
fi
info()  { printf '%s==>%s %s\n' "$c_blue$c_bold" "$c_reset" "$*"; }
ok()    { printf '%s  ok%s %s\n' "$c_green" "$c_reset" "$*"; }
warn()  { printf '%swarn%s %s\n' "$c_yellow" "$c_reset" "$*" >&2; }
die()   { printf '%serror%s %s\n' "$c_red$c_bold" "$c_reset" "$*" >&2; exit 1; }

# Opt-in override: reinstall even when Elowen is already present (never overrides the linked-checkout guard).
FORCE=false
[ -n "${ELOWEN_FORCE:-}" ] && FORCE=true

# ── platform ─────────────────────────────────────────────────────────────────
OS_NAME="$(uname -s)"

# ── privilege escalation ─────────────────────────────────────────────────────
# Linux: collect a `sudo` prefix once so every privileged step is explicit and the script also
# works when already run as root (empty prefix). macOS: the whole install is per-user — Homebrew
# and launchd gui agents both refuse root — so running under sudo would provision the wrong user.
SUDO=''
if [ "$OS_NAME" = "Darwin" ]; then
  [ "$(id -u)" -eq 0 ] && die "Do not run this installer as root on macOS — it provisions per-user launchd agents. Re-run without sudo."
elif [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO='sudo'
  else
    die "This installer needs root privileges. Re-run as root or install sudo first."
  fi
fi
as_root() { if [ -n "$SUDO" ]; then $SUDO "$@"; else "$@"; fi; }

# True only when a controlling terminal is actually usable. `[ -e /dev/tty ]` is unreliable — the device
# node exists on Linux even with no terminal (cron, `curl | bash` with no tty), so probe it by opening it.
has_tty() { { : < /dev/tty; } 2>/dev/null; }

# ── guard: don't clobber an existing install ─────────────────────────────────
# Runs before anything is changed. Bails on a linked checkout (npm link) that a reinstall would
# detach, and asks for confirmation before re-provisioning a machine that already runs Elowen.
guard_existing_install() {
  command -v elowen >/dev/null 2>&1 || return 0   # fresh machine — nothing to protect

  local ver; ver="$(elowen --version 2>/dev/null || echo '?')"

  # A globally-linked checkout (npm link): reinstalling via `npm install -g` replaces the symlink and
  # detaches that checkout. This must never be overridden — not even with ELOWEN_FORCE.
  local groot; groot="$(npm root -g 2>/dev/null || true)"
  if [ -n "$groot" ] && [ -L "$groot/elowen" ]; then
    die "Elowen $ver is already installed here from a linked checkout:
  $groot/elowen -> $(readlink "$groot/elowen")
Reinstalling would overwrite that link and detach the checkout. Update it in place instead (build the checkout, or 'elowen update')."
  fi

  # A normal global install already exists — don't re-provision a running instance by surprise.
  warn "Elowen $ver is already installed on this machine."
  if [ "$FORCE" = true ]; then
    warn "ELOWEN_FORCE is set — continuing with a reinstall and re-provision."
    return 0
  fi
  if has_tty; then
    printf 'Reinstall and re-provision anyway? [y/N] ' > /dev/tty
    local ans=''; read -r ans < /dev/tty || true
    case "$ans" in
      [yY] | [yY][eE][sS]) return 0 ;;
      *) info "Left the existing installation untouched. To update it, run: elowen update"; exit 0 ;;
    esac
  else
    die "Refusing to reinstall non-interactively. Set ELOWEN_FORCE=1 to override, or update with: elowen update"
  fi
}

# ── preflight ────────────────────────────────────────────────────────────────
info "Checking the environment"

if [ "$OS_NAME" = "Darwin" ]; then
  # Homebrew is the one bootstrap prerequisite on macOS: it provides Node and tmux. Installing brew
  # itself from inside a piped script is too invasive — point at the official one-liner instead.
  command -v brew >/dev/null 2>&1 || die \
    "Homebrew is required on macOS — install it first (https://brew.sh), then re-run this script."
elif ! command -v apt-get >/dev/null 2>&1; then
  die "This installer supports Debian/Ubuntu (apt) and macOS. On another OS, install Node.js ${MIN_NODE_MAJOR}+ manually, then run: npm install -g elowen && sudo elowen install"
fi

guard_existing_install

# curl + CA certs are needed to fetch the NodeSource setup script below (macOS ships curl).
if [ "$OS_NAME" != "Darwin" ] && ! command -v curl >/dev/null 2>&1; then
  info "Installing curl"
  as_root apt-get update -y
  as_root apt-get install -y curl ca-certificates
fi

# ── Node.js ──────────────────────────────────────────────────────────────────
node_major() {
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  node -v | sed -E 's/^v([0-9]+).*/\1/'
}

current_major="$(node_major)"
if [ "$current_major" -ge "$MIN_NODE_MAJOR" ] 2>/dev/null; then
  ok "Node.js $(node -v) already satisfies the >= ${MIN_NODE_MAJOR} requirement"
elif [ "$OS_NAME" = "Darwin" ]; then
  info "Installing Node.js via Homebrew"
  brew install node
  ok "Installed Node.js $(node -v)"
else
  if [ "$current_major" -eq 0 ]; then
    info "Node.js not found — installing Node.js ${MIN_NODE_MAJOR}.x from NodeSource"
  else
    info "Node.js $(node -v) is too old — installing Node.js ${MIN_NODE_MAJOR}.x from NodeSource"
  fi
  # NodeSource's setup script adds the apt repo + signing key, then we install nodejs (includes npm).
  # `sudo -E` preserves the environment the script expects; already-root just pipes into bash.
  if [ -n "$SUDO" ]; then
    curl -fsSL "$NODESOURCE_SETUP" | $SUDO -E bash -
  else
    curl -fsSL "$NODESOURCE_SETUP" | bash -
  fi
  as_root apt-get install -y nodejs
  ok "Installed Node.js $(node -v)"
fi

command -v npm >/dev/null 2>&1 || die "npm is missing even after installing Node.js — check the install output above."

# ── Elowen package ───────────────────────────────────────────────────────────
# macOS: brew's node prefix is user-writable, so the global install (and later self-updates) never
# need sudo. Linux: the global prefix is root-owned, so install through the sudo wrapper.
pkg_spec="elowen"
if [ -n "${ELOWEN_VERSION:-}" ]; then pkg_spec="elowen@${ELOWEN_VERSION}"; fi
info "Installing the ${c_bold}${pkg_spec}${c_reset} package globally"
if [ "$OS_NAME" = "Darwin" ]; then
  npm install -g --no-audit --no-fund "$pkg_spec"
else
  as_root npm install -g --no-audit --no-fund "$pkg_spec"
fi
command -v elowen >/dev/null 2>&1 || die "The 'elowen' command is not on PATH after install — check the npm global bin directory."
ok "Installed elowen $(elowen --version 2>/dev/null || echo '?')"

# ── hand off to the real provisioner ─────────────────────────────────────────
# Assemble the args for `elowen install`: explicit script args win, else ELOWEN_INSTALL_ARGS.
install_args=()
if [ "$#" -gt 0 ]; then
  install_args=("$@")
elif [ -n "${ELOWEN_INSTALL_ARGS:-}" ]; then
  # Word-split the env var into an argv array (installer flags never contain spaces in a single value).
  read -r -a install_args <<< "$ELOWEN_INSTALL_ARGS"
fi

info "Provisioning Elowen — handing over to 'elowen install'"

# macOS provisions per-user launchd agents — `elowen install` must run as the invoking user there,
# while Linux provisions system units and needs root.
provision() {
  if [ "$OS_NAME" = "Darwin" ]; then elowen install "$@"; else as_root elowen install "$@"; fi
}

# The interactive wizard reads from stdin, but under `curl | bash` stdin is the piped script.
# Reconnect it to the controlling terminal so the prompts work. When there is no terminal
# (CI, no /dev/tty), an unattended run is the only viable path.
unattended=false
for a in "${install_args[@]:-}"; do [ "$a" = "--unattended" ] && unattended=true; done

if [ "$unattended" = true ]; then
  provision "${install_args[@]}"
elif has_tty; then
  provision "${install_args[@]}" < /dev/tty
else
  die "No terminal available for the interactive wizard. Re-run with an unattended install, e.g.:
  ELOWEN_INSTALL_ARGS='--unattended --localhost --admin-user admin --admin-pass CHANGEME --agents none' bash install.sh"
fi
