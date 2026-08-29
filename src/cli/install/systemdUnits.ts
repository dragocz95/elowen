/** Pure renderers for the two systemd unit files `elowen install` writes. Kept string-only and
 *  side-effect-free so they're unit-tested without touching /etc; the wizard writes + enables them. */
import { SITE_GATEWAY_HELPER_PATH } from '../../shared/siteGateway.js';
import { SERVICES } from '../systemd.js';

export interface UnitParams {
  /** Unprivileged system user the services run as (never root). */
  user: string;
  /** That user's HOME — holds ~/.config/elowen (DB, logs, config) and the agent CLIs' auth. */
  home: string;
  /** Absolute node binary (ExecStart can't rely on PATH resolution at unit level). */
  nodePath: string;
  /** Absolute path to the installed daemon entry (dist/daemon/index.js inside the global package). */
  daemonEntry: string;
  /** Absolute path to the bundled web standalone server (web-dist/server.js). */
  webServer: string;
  /** npm global bin dir — prepended to PATH so the service finds `elowen` and the agent CLIs. */
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

// A UTF-8 locale the daemon/web units pin explicitly, so accented output (Czech clients, names) never
// depends on whatever locale systemd's default environment happens to carry — a box whose default lacks
// one runs the process under the ASCII charmap and mangles every non-ASCII byte. C.UTF-8 is the
// locale-independent UTF-8 that glibc ships without a generated locale, so it is always resolvable.
const UTF8_LOCALE = 'C.UTF-8';

export function daemonUnit(p: UnitParams): string {
  return `[Unit]
Description=ELOWEN daemon (REST API)
After=network.target
# If the install vanished (broken uninstall left the units behind), the daemon entry is gone and
# every start would fail. ConditionPathExists turns that into a single skipped-start log line:
# the process never runs, so Restart= below has nothing to restart — no crash loop.
ConditionPathExists=${p.daemonEntry}
# Start limit aligned with RestartSec=3 below: five starts at 3 s spacing span 15 s, so the default
# 10 s window can never fit a sixth start and the burst of 5 is unreachable — any boot-time crash
# loop would run forever. 30 s keeps that default burst of 5 but actually trips: the 6th start at
# ~15 s is refused. Re-derive both if RestartSec ever changes.
StartLimitIntervalSec=30
StartLimitBurst=5

[Service]
Type=simple
User=${p.user}
Environment=ELOWEN_CLI=elowen
Environment=ELOWEN_DB=${p.home}/.config/elowen/elowen.db
Environment=ELOWEN_LOG_DIR=${p.home}/.config/elowen/logs
Environment=ELOWEN_PORT=${p.daemonPort}
Environment=ELOWEN_HOST=${p.daemonHost}
# Pins the service identity for the launcher's pid check; the daemon's explicit value also keeps an
# exported ELOWEN_DAEMON_URL from ever making it read as the web.
Environment=ELOWEN_SERVICE=daemon
Environment=PATH=${p.npmGlobalBin}:${BASE_PATH}
Environment=LANG=${UTF8_LOCALE}
ExecStart=${p.nodePath} ${p.daemonEntry}
Restart=on-failure
# A requested restart (the /restart command, the web button) drains and exits 75 (EX_TEMPFAIL,
# RESTART_EXIT_CODE in bootstrap.ts) instead of running systemctl restart from inside the daemon, which
# would ask systemd to kill the very process issuing the command. Restart=on-failure already covers a
# non-zero status, so this line is the explicit statement that 75 means "restart me", and it keeps holding
# if that policy is ever narrowed. A clean stop still exits 0 and stays stopped.
RestartForceExitStatus=75
RestartSec=3
# Signal the daemon ALONE on stop, not the whole control group. The daemon forks sub-agent runners as
# child processes; the default KillMode=control-group delivers SIGTERM to them at the SAME instant as the
# daemon, so a runner aborts its in-flight delegations before the drain below can wait for even one to
# finish. With mixed, only the main process gets SIGTERM — the runners keep working through the drain,
# and systemd SIGKILLs whatever is still in the cgroup once the daemon has exited (by then a drained
# runner has nothing left to finish). Without this the TimeoutStopSec drain protects turns but not the
# delegated work running beside them.
KillMode=mixed
# The daemon drains running turns on SIGTERM (SHUTDOWN_DRAIN_MS, 10 min) before exiting. The default
# stop timeout is 90s, which would SIGKILL it mid-drain and destroy the very work being waited for.
# Keep this ABOVE that drain budget; the daemon always gives up on its own first.
TimeoutStopSec=660

[Install]
WantedBy=multi-user.target
`;
}

/** Oneshot unit the timer fires: `elowen update --auto`. Runs as the same unprivileged service user and
 *  with the same ELOWEN_DB as the daemon, so it reads the auto-update opt-in from the right DB.
 *  No [Install] section — it's never enabled directly, only triggered by elowen-update.timer. */
export function updateService(p: UnitParams): string {
  return `[Unit]
Description=ELOWEN auto-update (npm release check + in-place restart)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=${p.user}
Environment=ELOWEN_DB=${p.home}/.config/elowen/elowen.db
Environment=ELOWEN_LOG_DIR=${p.home}/.config/elowen/logs
Environment=PATH=${p.npmGlobalBin}:${BASE_PATH}
ExecStart=${p.npmGlobalBin}/elowen update --auto
`;
}

/** Hourly timer driving elowen-update.service. Persistent so a run missed while the box was off fires on
 *  the next boot; the service itself no-ops when auto-update is off or a mission is running. */
export function updateTimer(): string {
  return `[Unit]
Description=ELOWEN hourly auto-update check

[Timer]
OnBootSec=15min
OnUnitActiveSec=1h
Persistent=true

[Install]
WantedBy=timers.target
`;
}

/** sudoers drop-in letting the unprivileged service user run — without a password — only the
 *  privileged operations Elowen owns: restart its units, reinstall itself, and invoke the root-owned
 *  published-sites gateway helper with NO arguments (its bounded JSON request arrives on stdin). The
 *  helper grant is not a shell and accepts no path or command. Every command is pinned literally and the
 *  completed file is validated with `visudo -c` before it is trusted. */
export function elowenSudoers(user: string, reinstallCmd: string): string {
  // Built from SERVICES so the pinned restart command can't drift from what `systemctl('restart',
  // '--no-block', ...SERVICES)` actually issues (sudo matches arguments positionally). --no-block lets a
  // web-triggered self-update enqueue BOTH unit restarts before the daemon's own restart kills it.
  const units = SERVICES.join(' ');
  return `# Managed by elowen install — lets the ${user} service user restart its own units and self-update in place (auto-update + manual update).
${user} ALL=(root) NOPASSWD: /usr/bin/systemctl restart --no-block ${units}, /usr/bin/systemctl is-active ${units}
${user} ALL=(root) NOPASSWD: ${reinstallCmd}
${user} ALL=(root) NOPASSWD: ${SITE_GATEWAY_HELPER_PATH}
`;
}

export function webUnit(p: UnitParams): string {
  return `[Unit]
Description=ELOWEN web UI
After=network.target elowen-daemon.service
Wants=elowen-daemon.service
# Same two guards as the daemon unit: skip when the web entry is missing (no crash loop), and trip
# the start limit when the entry exists but crashes at boot. Window/burst pair matches RestartSec=3.
ConditionPathExists=${p.webServer}
StartLimitIntervalSec=30
StartLimitBurst=5

[Service]
Type=simple
User=${p.user}
Environment=PORT=${p.webPort}
Environment=HOSTNAME=${p.webHost}
Environment=ELOWEN_DAEMON_URL=http://127.0.0.1:${p.daemonPort}${p.wsDirectPort ? `\nEnvironment=ELOWEN_WS_DIRECT_PORT=${p.wsDirectPort}` : ''}
# Pins the service identity for the launcher's pid check — Next.js overwrites the web's argv
# (process.title) at boot, so the env marker, not the cmdline, says what this process is.
Environment=ELOWEN_SERVICE=web
Environment=ELOWEN_LOG_DIR=${p.home}/.config/elowen/logs
Environment=PATH=${p.npmGlobalBin}:${BASE_PATH}
Environment=LANG=${UTF8_LOCALE}
ExecStart=${p.nodePath} ${p.webServer}
Restart=on-failure
RestartSec=3
# A BACKSTOP, not the fix. Next's standalone server ships no signal handler, so the build injects one
# (scripts/build-web-bundle.mjs) and a stop then completes in milliseconds. Should a bundle ever reach a
# box without it, the default 90 s stop timeout is long enough that systemd records the stop as FAILED —
# and a failed stop makes it discard the START half of a restart, leaving the web down until someone
# notices. Fifteen seconds keeps that from turning a slow stop into an outage.
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
`;
}
