import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, constants } from 'node:fs/promises';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, basename, join } from 'node:path';
import { isNewer } from './version.js';
import { start, stop, isAlive } from './launcher.js';
import { readInstallInfo } from './installInfo.js';
import { restartServices } from './systemd.js';
import { launchdRestart } from './launchd.js';
import { dataDir } from '../shared/paths.js';
import { fetchLatestVersion } from '../shared/registry.js';

const execFileAsync = promisify(execFile);

/** The npm `--prefix` this very binary lives under, so `elowen update` reinstalls *itself* in place —
 *  no matter where it was globally installed (e.g. a www-data-owned prefix), and without the operator
 *  having to remember any `--prefix`. Returns null when run from a source checkout (no node_modules in
 *  the path), in which case we let npm use its default global prefix. Exported so `elowen install` pins
 *  the exact same self-reinstall command in sudoers. */
export function selfPrefix(): string | null {
  const here = fileURLToPath(import.meta.url); // <prefix>[/lib]/node_modules/elowen/dist/cli/update.js
  const idx = here.lastIndexOf('/node_modules/');
  if (idx === -1) return null;
  let base = here.slice(0, idx); // <prefix>/lib  (global, has lib/)  OR  <prefix>  (prefix-style install)
  if (basename(base) === 'lib') base = dirname(base);
  return base;
}

/** The exact `node_modules` directory npm rewrites on an in-place self-update (it renames the
 *  elowen package to a temp sibling there). Writability of THIS dir decides whether the reinstall
 *  needs root. Derived straight from the binary's own path so it's correct for both `lib/node_modules`
 *  (global) and bare-`node_modules` prefixes. Null from a source checkout. */
function selfPackagesDir(): string | null {
  const here = fileURLToPath(import.meta.url);
  const marker = '/node_modules/';
  const idx = here.lastIndexOf(marker);
  return idx === -1 ? null : here.slice(0, idx + marker.length - 1);
}

/** The npm args that reinstall elowen in place, pinned identically by `elowen install` (sudoers) and
 *  run by `elowen update` — the single source of truth for the self-update command. */
export function reinstallNpmArgs(prefix: string | null): string[] {
  return ['install', '-g', 'elowen@latest', ...(prefix ? ['--prefix', prefix] : [])];
}

/** Resolve npm to the SAME absolute path the sudoers drop-in pins (`elowen install` also runs `which npm`),
 *  so a sudo'd reinstall matches the pin instead of relying on root's `secure_path` resolving a bare
 *  `npm` identically. Falls back to bare `npm` (PATH) if resolution fails. */
async function resolveNpm(): Promise<string> {
  try { const { stdout } = await execFileAsync('which', ['npm']); const p = stdout.trim(); if (p) return p; } catch { /* not resolvable — fall back to PATH */ }
  return 'npm';
}

/** Injectable IO for the in-place reinstall, so the root-vs-not decision is unit-testable. */
export interface ReinstallIO {
  packagesDir: () => string | null;
  prefix: () => string | null;
  writable: (dir: string) => Promise<boolean>;
  npmPath: () => Promise<string>;
  exec: (cmd: string, args: string[]) => Promise<void>;
}

const defaultReinstallIO: ReinstallIO = {
  packagesDir: selfPackagesDir,
  prefix: selfPrefix,
  writable: async (dir) => { try { await access(dir, constants.W_OK); return true; } catch { return false; } },
  npmPath: resolveNpm,
  exec: async (cmd, args) => { await execFileAsync(cmd, args); },
};

/** Reinstall elowen in place. When the global packages dir isn't writable by the current user
 *  (the common "installed as root in /usr, daemon runs as a non-root service user" layout), route
 *  the npm install through `sudo` — `elowen install` grants exactly this command via a pinned sudoers
 *  drop-in. A writable prefix (root, or a service-user-owned prefix) installs directly, no sudo. The
 *  absolute npm path is used in BOTH branches so the sudo'd command matches the pinned absolute path. */
export async function reinstall(io: ReinstallIO = defaultReinstallIO): Promise<void> {
  const args = reinstallNpmArgs(io.prefix());
  const dir = io.packagesDir();
  const needsRoot = dir !== null && !(await io.writable(dir));
  const npm = await io.npmPath();
  if (needsRoot) await io.exec('sudo', [npm, ...args]);
  else await io.exec(npm, args);
}

export interface UpdateDeps {
  fetch?: typeof fetch;
  current: string;
  /** Run the global install. Injected for tests; defaults to `npm i -g elowen@latest`. */
  install?: () => Promise<void>;
  /** Restart running services after a successful install. */
  restart?: (env: NodeJS.ProcessEnv) => Promise<void>;
  /** File lock serialising concurrent update runs. Injected for tests; the real default writes
   *  `update.lock` under ~/.config/elowen, next to the launcher's own start.lock. */
  lock?: UpdateLockDeps;
}

/** The pieces of the cross-process update lock a test needs to control; defaults hit the real fs. */
export interface UpdateLockDeps {
  /** Absolute lock file path for a given env (the file lives under the same data dir as run.json). */
  lockPath: (env: NodeJS.ProcessEnv) => string;
  /** Whether the recorded holder pid is still alive — a dead one means the lock is stale and reclaimable. */
  isAlive: (pid: number) => boolean;
}

const defaultUpdateLockDeps: UpdateLockDeps = {
  lockPath: (env) => join(dataDir(env), 'update.lock'),
  isAlive,
};

/** Serialise `elowen update` runs across processes (manual, menu, and the hourly --auto timer alike) with
 *  a pid-stamped lock file. Two concurrent runs would both `npm install -g` and BOTH restart the services —
 *  the second restart then killing the freshly-started ones — so the loser must fail fast instead of
 *  racing. A lock whose recorded pid is gone (a crash between acquire and release) is stale: reclaim it,
 *  exactly like the launcher's start.lock, so one hard kill can't jam every future update. */
export function acquireUpdateLock(env: NodeJS.ProcessEnv, deps: UpdateLockDeps): () => void {
  const path = deps.lockPath(env);
  mkdirSync(dirname(path), { recursive: true });
  for (;;) {
    try {
      writeFileSync(path, String(process.pid), { flag: 'wx' });
      return () => { try { rmSync(path, { force: true }); } catch { /* already gone */ } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let holder = NaN;
      try { holder = Number(readFileSync(path, 'utf8').trim()); } catch { /* vanished mid-read — next iteration acquires */ }
      if (Number.isInteger(holder) && holder > 0 && deps.isAlive(holder)) {
        throw new Error('another `elowen update` is already in progress — wait for it to finish and try again');
      }
      try { rmSync(path, { force: true }); } catch { /* raced with the holder's own release */ }
    }
  }
}

export interface UpdateResult { updated: boolean; from: string; to: string }

/** The systemd half of an update restart. Exactly one canonical non-blocking attempt is allowed: falling
 *  back to a blocking legacy command can deadlock when the updater runs inside the daemon cgroup. */
export async function restartSystemdAfterUpdate(
  latest: string,
  restart: (target: 'all') => Promise<{ code: number; stdout: string }> = restartServices,
): Promise<void> {
  const result = await restart('all');
  if (result.code !== 0) {
    throw new Error(`installed ${latest} but the safe restart failed (code ${result.code}) — re-run elowen install to refresh sudoers, then run elowen restart all`);
  }
}

/** Check npm for a newer release; if there is one, install it and restart the (running) services so
 *  the new binary takes over. The DB migrates itself on the next boot (openDb runs additive
 *  migrations), so no migration step is needed here. Returns what happened for the menu to report. */
export async function update(env: NodeJS.ProcessEnv, deps: UpdateDeps): Promise<UpdateResult> {
  // The whole run is mutually exclusive: the loser must not even reach the version check while the
  // winner is mid-install, or it would "see" the newer version, install it again and restart a second
  // time — undoing the winner's restart. Refusal happens here, before any work.
  const release = acquireUpdateLock(env, deps.lock ?? defaultUpdateLockDeps);
  try {
    const fetchFn = deps.fetch ?? fetch;
    const latest = await fetchLatestVersion(fetchFn);
    // Registry unreachable (null) → can't tell if newer, so treat as a no-op rather than throwing, which
    // would redden the hourly update timer on a transient blip.
    if (latest === null || !isNewer(latest, deps.current)) return { updated: false, from: deps.current, to: latest ?? deps.current };

    const install = deps.install ?? (() => reinstall());
    await install();

    // A box provisioned by `elowen install` is systemd-managed — restart those units (sudo when not root).
    // A plain launcher install has no install.json — fall back to stop/start of our own spawned daemon.
    const restart = deps.restart ?? (async (e) => {
      if (readInstallInfo()) {
        // A macOS box provisioned by `elowen install` runs per-user launchd agents — kickstart them (the
        // invoking user owns them, so no sudo and no --no-block dance is needed).
        if (process.platform === 'darwin') {
          const mac = await launchdRestart();
          if (mac.code !== 0) throw new Error(`installed ${latest} but the launchd restart failed (code ${mac.code}) — services run the old build until restarted`);
          return;
        }
        // `--no-block`: a web-triggered update spawns this `elowen update` INSIDE elowen-daemon's systemd
        // cgroup, so a blocking `systemctl restart elowen-daemon elowen-web` would have the daemon's own
        // restart kill this process (and the waiting systemctl client) the instant elowen-daemon stops —
        // before the elowen-web job is ever enqueued, leaving the web UI on the old build. With --no-block
        // both jobs are handed to systemd (PID 1) up front and run to completion regardless of this
        // process dying. (Cost: we can't observe the restart result — only that it was enqueued.)
        await restartSystemdAfterUpdate(latest);
        return;
      }
      await stop(e);
      await start(e, { version: latest });
    });
    await restart(env);

    return { updated: true, from: deps.current, to: latest };
  } finally {
    release();
  }
}
