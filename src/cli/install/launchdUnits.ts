/** Pure renderers for the launchd LaunchAgent plists `elowen install` writes on macOS — the launchd
 *  counterpart of systemdUnits.ts. Kept string-only and side-effect-free so they're unit-tested without
 *  touching ~/Library; the wizard writes + bootstraps them.
 *
 *  macOS model: everything runs as the CURRENT user in the `gui/<uid>` domain (LaunchAgents start at
 *  login) — no root, no dedicated service user, no reverse proxy. The daemon and web bind localhost
 *  only; KeepAlive.SuccessfulExit=false mirrors systemd's Restart=on-failure. */

export const LAUNCHD_DAEMON_LABEL = 'io.elowen.daemon';
export const LAUNCHD_WEB_LABEL = 'io.elowen.web';
export const LAUNCHD_UPDATE_LABEL = 'io.elowen.update';
/** The two long-running agents (the update agent is a timer, not a service). Order matters: the daemon
 *  first, so a start/restart brings the API up before the web UI that proxies to it. */
export const LAUNCHD_SERVICES = [LAUNCHD_DAEMON_LABEL, LAUNCHD_WEB_LABEL];

export interface LaunchdParams {
  /** The invoking user's HOME — holds ~/.config/elowen (DB, logs, config) and ~/Library/LaunchAgents. */
  home: string;
  /** Absolute node binary (launchd resolves no PATH for ProgramArguments). */
  nodePath: string;
  /** Absolute path to the installed daemon entry (dist/daemon/index.js inside the global package). */
  daemonEntry: string;
  /** Absolute path to the bundled web standalone server (web-dist/server.js). */
  webServer: string;
  /** npm global bin dir — prepended to PATH so the agents find `elowen` and the agent CLIs. */
  npmGlobalBin: string;
  daemonPort: number;
  webPort: number;
}

/** Homebrew (both arches) + system paths — what a login shell would have, minus user dotfiles. */
const BASE_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

export function agentPlistPath(home: string, label: string): string {
  return `${home}/Library/LaunchAgents/${label}.plist`;
}

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One <dict> of environment variables, indented for the plist body. */
const envDict = (env: Record<string, string>): string =>
  Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join('\n');

const plist = (label: string, body: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
${body}
</dict>
</plist>
`;

/** Long-running agent scaffold shared by the daemon and web plists. */
function serviceBody(p: LaunchdParams, program: string[], env: Record<string, string>, logName: string): string {
  return `  <key>ProgramArguments</key>
  <array>
${program.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envDict({ ...env, PATH: `${p.npmGlobalBin}:${BASE_PATH}` })}
  </dict>
  <key>WorkingDirectory</key><string>${xml(p.home)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>3</integer>
  <key>StandardOutPath</key><string>${xml(`${p.home}/.config/elowen/logs/${logName}.log`)}</string>
  <key>StandardErrorPath</key><string>${xml(`${p.home}/.config/elowen/logs/${logName}.log`)}</string>`;
}

export function daemonAgent(p: LaunchdParams): string {
  return plist(LAUNCHD_DAEMON_LABEL, serviceBody(p, [p.nodePath, p.daemonEntry], {
    ELOWEN_CLI: 'elowen',
    ELOWEN_DB: `${p.home}/.config/elowen/elowen.db`,
    ELOWEN_LOG_DIR: `${p.home}/.config/elowen/logs`,
    ELOWEN_PORT: String(p.daemonPort),
    ELOWEN_HOST: '127.0.0.1',
  }, 'launchd-daemon'));
}

export function webAgent(p: LaunchdParams): string {
  return plist(LAUNCHD_WEB_LABEL, serviceBody(p, [p.nodePath, p.webServer], {
    PORT: String(p.webPort),
    HOSTNAME: '127.0.0.1',
    ELOWEN_DAEMON_URL: `http://127.0.0.1:${p.daemonPort}`,
    ELOWEN_LOG_DIR: `${p.home}/.config/elowen/logs`,
  }, 'launchd-web'));
}

/** Hourly auto-update check — launchd's counterpart of elowen-update.timer + .service. The command
 *  itself no-ops unless the operator turns auto-update on in Settings, exactly like the systemd pair. */
export function updateAgent(p: LaunchdParams): string {
  return plist(LAUNCHD_UPDATE_LABEL, `  <key>ProgramArguments</key>
  <array>
    <string>${xml(`${p.npmGlobalBin}/elowen`)}</string>
    <string>update</string>
    <string>--auto</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envDict({
    ELOWEN_DB: `${p.home}/.config/elowen/elowen.db`,
    ELOWEN_LOG_DIR: `${p.home}/.config/elowen/logs`,
    PATH: `${p.npmGlobalBin}:${BASE_PATH}`,
  })}
  </dict>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>${xml(`${p.home}/.config/elowen/logs/launchd-update.log`)}</string>
  <key>StandardErrorPath</key><string>${xml(`${p.home}/.config/elowen/logs/launchd-update.log`)}</string>`);
}
