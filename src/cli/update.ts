import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, constants } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, basename } from 'node:path';
import { isNewer } from './version.js';
import { start, stop } from './launcher.js';
import { readInstallInfo } from './installInfo.js';
import { SERVICES, systemctl } from './systemd.js';
import { launchdRestart } from './launchd.js';
import { hasLiveMission } from './missionGate.js';
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
  /** Re-checked RIGHT BEFORE the restart (after the multi-second npm install) — false means "don't
   *  restart now". Defaults to "no mission is live", so a mission that started during the install isn't
   *  killed by the restart. Injected for tests. */
  confirmReadyToRestart?: () => boolean;
}

/** `restartDeferred`: the new version installed but a restart was withheld (a mission went live during
 *  the install) — it takes over on the next restart/boot. */
export interface UpdateResult { updated: boolean; from: string; to: string; restartDeferred?: boolean }

/** Check npm for a newer release; if there is one, install it and restart the (running) services so
 *  the new binary takes over. The DB migrates itself on the next boot (openDb runs additive
 *  migrations), so no migration step is needed here. Returns what happened for the menu to report. */
export async function update(env: NodeJS.ProcessEnv, deps: UpdateDeps): Promise<UpdateResult> {
  const fetchFn = deps.fetch ?? fetch;
  const latest = await fetchLatestVersion(fetchFn);
  // Registry unreachable (null) → can't tell if newer, so treat as a no-op rather than throwing, which
  // would redden the hourly update timer on a transient blip.
  if (latest === null || !isNewer(latest, deps.current)) return { updated: false, from: deps.current, to: latest ?? deps.current };

  const install = deps.install ?? (() => reinstall());
  await install();

  // A mission may have started during the install — re-check before the restart (which would kill its
  // agents). If so, leave the freshly-installed binary in place to take over on the next restart/boot.
  const readyToRestart = deps.confirmReadyToRestart ?? (() => !hasLiveMission(env));
  if (!readyToRestart()) return { updated: true, from: deps.current, to: latest, restartDeferred: true };

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
      const r = await systemctl('restart', '--no-block', ...SERVICES);
      if (r.code === 0) return;
      // A box provisioned before `--no-block` was added to the sudoers pin denies the new arg list
      // (sudo matches arguments exactly), so the agent-user restart fails here. Fall back to the legacy
      // command — which the old drop-in still permits — so self-update never hard-breaks. Re-running
      // `elowen install` re-pins sudoers with --no-block and restores the elowen-web restart fix; until
      // then a web-triggered update degrades to the old behavior (daemon restarts, web may not).
      const legacy = await systemctl('restart', ...SERVICES);
      if (legacy.code !== 0) throw new Error(`installed ${latest} but the restart failed (code ${legacy.code}) — services run the old build until restarted`);
      return;
    }
    await stop(e);
    await start(e, { version: latest });
  });
  await restart(env);

  return { updated: true, from: deps.current, to: latest };
}
