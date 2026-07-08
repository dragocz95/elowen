import { spawn } from 'node:child_process';
import { readPkgVersion, readPkgInstalledAt } from '../shared/pkgVersion.js';
import { fetchLatestVersion } from '../shared/registry.js';
import { logger } from '../shared/logger.js';

const log = logger('system');

/** This package's version, read once from its package.json. Surfaced on /health so the web UI can show it. */
export const ELOWEN_VERSION = readPkgVersion(import.meta.url);

/** When this build was last installed (package.json mtime, ISO) — surfaced on /system as "last updated". */
export const ELOWEN_INSTALLED_AT = readPkgInstalledAt(import.meta.url);

/** Port the daemon listens on — the MCP route reaches back into this same daemon's REST API at it. */
export const ELOWEN_PORT = Number((process.env.ELOWEN_PORT) ?? 4400);

// Latest published elowen version from the npm registry, cached for 30 min so the System panel's
// polling never hammers npm. A failed fetch keeps any prior good value and returns null otherwise —
// the panel just won't show an "update available" badge rather than erroring.
let latestCache: { ts: number; val: string | null } | null = null;
const LATEST_TTL_MS = 30 * 60 * 1000;
export async function defaultLatestVersion(): Promise<string | null> {
  const now = Date.now();
  if (latestCache && now - latestCache.ts < LATEST_TTL_MS) return latestCache.val;
  const val = await fetchLatestVersion(); // null on any failure — keep last good below
  latestCache = { ts: now, val: val ?? latestCache?.val ?? null };
  return latestCache.val;
}

/** Kick off a manual `elowen update`, detached so the HTTP request can return without waiting on the
 *  install. The updater still runs inside elowen-daemon's systemd cgroup, so it can't outlive the daemon
 *  restart it triggers — that's why `update()` restarts the units with `systemctl --no-block`, handing
 *  both jobs to PID 1 up front so elowen-web restarts even after this process is killed. Caller gates on
 *  missions first. */
export function defaultStartUpdate(): void {
  spawn('elowen', ['update'], { detached: true, stdio: 'ignore' }).unref();
}

/** Restart one of the elowen systemd units, detached and `--no-block` so PID 1 owns the job — restarting
 *  elowen-daemon kills this very process, so nothing may wait on the child. The operator account is
 *  expected to hold passwordless sudo for exactly these commands; on a non-systemd host the spawn just
 *  fails and is logged (the HTTP response has already gone out by then). */
export function defaultStartRestart(target: 'daemon' | 'web'): void {
  const child = spawn('sudo', ['systemctl', 'restart', '--no-block', `elowen-${target}`], { detached: true, stdio: 'ignore' });
  child.on('error', (err) => log.warn(`failed to spawn restart of elowen-${target}: ${String(err)}`));
  child.unref();
}
