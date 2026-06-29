/** Pure renderers for the two systemd unit files `orca install` writes. Kept string-only and
 *  side-effect-free so they're unit-tested without touching /etc; the wizard writes + enables them. */
import { SERVICES } from '../systemd.js';

export interface UnitParams {
  /** Unprivileged system user the services run as (never root). */
  user: string;
  /** That user's HOME — holds ~/.config/orca (DB, logs, config) and the agent CLIs' auth. */
  home: string;
  /** Absolute node binary (ExecStart can't rely on PATH resolution at unit level). */
  nodePath: string;
  /** Absolute path to the installed daemon entry (dist/daemon/index.js inside the global package). */
  daemonEntry: string;
  /** Absolute path to the bundled web standalone server (web-dist/server.js). */
  webServer: string;
  /** npm global bin dir — prepended to PATH so the service finds `orca` and the agent CLIs. */
  npmGlobalBin: string;
  daemonPort: number;
  webPort: number;
  /** Interface the web server binds. `127.0.0.1` when a reverse proxy fronts it; `0.0.0.0` for the
   *  proxy-less "direct port" mode where the browser hits http://<host>:<webPort> straight. */
  webHost: string;
  /** Interface the daemon binds. `127.0.0.1` behind a proxy or on localhost (kept private); `0.0.0.0`
   *  in proxy-less IP mode, so the browser can open the terminal WebSocket straight at the daemon. */
  daemonHost: string;
  /** Only set in proxy-less IP mode: the daemon's public port, handed to the browser so it builds the
   *  terminal WS URL as `ws://<host>:<port>/ws/terminal` (no nginx `/ws/` hop to bridge it). Unset
   *  behind a proxy / on localhost, where the WS rides the same origin as the web UI. */
  wsDirectPort?: number;
}

const BASE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export function daemonUnit(p: UnitParams): string {
  return `[Unit]
Description=ORCA daemon (REST API)
After=network.target

[Service]
Type=simple
User=${p.user}
Environment=ORCA_CLI=orca
Environment=ORCA_DB=${p.home}/.config/orca/orca.db
Environment=ORCA_LOG_DIR=${p.home}/.config/orca/logs
Environment=ORCA_PORT=${p.daemonPort}
Environment=ORCA_HOST=${p.daemonHost}
Environment=PATH=${p.npmGlobalBin}:${BASE_PATH}
ExecStart=${p.nodePath} ${p.daemonEntry}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
`;
}

/** Oneshot unit the timer fires: `orca update --auto`. Runs as the same unprivileged service user and
 *  with the same ORCA_DB as the daemon, so it reads the opt-in flag + live missions from the right DB.
 *  No [Install] section — it's never enabled directly, only triggered by orca-update.timer. */
export function updateService(p: UnitParams): string {
  return `[Unit]
Description=ORCA auto-update (npm release check + in-place restart)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=${p.user}
Environment=ORCA_DB=${p.home}/.config/orca/orca.db
Environment=ORCA_LOG_DIR=${p.home}/.config/orca/logs
Environment=PATH=${p.npmGlobalBin}:${BASE_PATH}
ExecStart=${p.npmGlobalBin}/orca update --auto
`;
}

/** Hourly timer driving orca-update.service. Persistent so a run missed while the box was off fires on
 *  the next boot; the service itself no-ops when auto-update is off or a mission is running. */
export function updateTimer(): string {
  return `[Unit]
Description=ORCA hourly auto-update check

[Timer]
OnBootSec=15min
OnUnitActiveSec=1h
Persistent=true

[Install]
WantedBy=timers.target
`;
}

/** sudoers drop-in letting the unprivileged service user run — without a password — exactly the two
 *  privileged steps `orca update` needs: restart its own units, and reinstall orca in place. The
 *  reinstall grant is required when orca lives in a root-owned global prefix (e.g. `/usr`) while the
 *  daemon runs as a non-root service user, where a plain `npm install -g` would hit EACCES. Both are
 *  pinned to the literal commands orca issues (least privilege); `reinstallCmd` is the absolute,
 *  fully-resolved npm command so sudo matches it. Validated with `visudo -c` before it's trusted. */
export function orcaSudoers(user: string, reinstallCmd: string): string {
  // Built from SERVICES so the pinned restart command can't drift from what `systemctl('restart',
  // '--no-block', ...SERVICES)` actually issues (sudo matches arguments positionally). --no-block lets a
  // web-triggered self-update enqueue BOTH unit restarts before the daemon's own restart kills it.
  const units = SERVICES.join(' ');
  return `# Managed by orca install — lets the ${user} service user restart its own units and self-update in place (auto-update + manual update).
${user} ALL=(root) NOPASSWD: /usr/bin/systemctl restart --no-block ${units}, /usr/bin/systemctl is-active ${units}
${user} ALL=(root) NOPASSWD: ${reinstallCmd}
`;
}

export function webUnit(p: UnitParams): string {
  return `[Unit]
Description=ORCA web UI
After=network.target orca-daemon.service
Wants=orca-daemon.service

[Service]
Type=simple
User=${p.user}
Environment=PORT=${p.webPort}
Environment=HOSTNAME=${p.webHost}
Environment=ORCA_DAEMON_URL=http://127.0.0.1:${p.daemonPort}${p.wsDirectPort ? `\nEnvironment=ORCA_WS_DIRECT_PORT=${p.wsDirectPort}` : ''}
Environment=ORCA_LOG_DIR=${p.home}/.config/orca/logs
Environment=PATH=${p.npmGlobalBin}:${BASE_PATH}
ExecStart=${p.nodePath} ${p.webServer}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
`;
}
