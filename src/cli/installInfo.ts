import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Metadata `elowen install` records about a systemd-provisioned box, so the launcher menu can show the
 *  real public URL the operator chose (not a hard-coded localhost) and drive the systemd units instead
 *  of spawning a second, conflicting detached daemon. Absent file ⇒ a plain npm (Model-B) install. */
export interface InstallInfo {
  /** Canonical URL to reach the web UI (https://domain, http://<ip>:4500, http://localhost:4500). */
  publicUrl: string;
  mode: 'domain' | 'ip' | 'localhost';
  serviceUser: string;
  daemonPort: number;
  webPort: number;
}

/** Linux: system-wide so any user invoking `elowen` (typically root) can read it, regardless of which
 *  user the services run as. macOS: everything is per-user (launchd agents in the invoker's gui domain,
 *  no root anywhere), so the record lives next to the rest of ~/.config/elowen. */
export const INSTALL_INFO_PATH = process.platform === 'darwin'
  ? join(homedir(), '.config', 'elowen', 'install.json')
  : '/etc/elowen/install.json';

export function readInstallInfo(path = INSTALL_INFO_PATH): InstallInfo | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as InstallInfo; }
  catch { return null; }
}

export function serializeInstallInfo(info: InstallInfo): string {
  return JSON.stringify(info, null, 2);
}

/** The web UI URL to point a user at: the real public URL on a systemd-provisioned box, otherwise the
 *  local standalone web port (honouring ELOWEN_WEB_PORT, same as the launcher). One source of truth for the
 *  setup outro, `elowen doctor`, and headless setup. */
export function webBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const port = Number((env.ELOWEN_WEB_PORT)) || 4500;
  return readInstallInfo()?.publicUrl ?? `http://localhost:${port}`;
}
