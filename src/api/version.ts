import { spawn } from 'node:child_process';
import { readPkgVersion } from '../shared/pkgVersion.js';
import { fetchLatestVersion } from '../shared/registry.js';

/** This package's version, read once from its package.json. Surfaced on /health so the web UI can show it. */
export const ORCA_VERSION = readPkgVersion(import.meta.url);

/** Port the daemon listens on — the MCP route reaches back into this same daemon's REST API at it. */
export const ORCA_PORT = Number(process.env.ORCA_PORT ?? 4400);

// Latest published orcasynth version from the npm registry, cached for 30 min so the System panel's
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

/** Kick off a manual `orca update`, detached so the HTTP request can return without waiting on the
 *  install. The updater still runs inside orca-daemon's systemd cgroup, so it can't outlive the daemon
 *  restart it triggers — that's why `update()` restarts the units with `systemctl --no-block`, handing
 *  both jobs to PID 1 up front so orca-web restarts even after this process is killed. Caller gates on
 *  missions first. */
export function defaultStartUpdate(): void {
  spawn('orca', ['update'], { detached: true, stdio: 'ignore' }).unref();
}
