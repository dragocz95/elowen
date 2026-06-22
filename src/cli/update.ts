import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, basename } from 'node:path';
import { isNewer } from './version.js';
import { start, stop } from './launcher.js';
import { readInstallInfo } from './installInfo.js';
import { SERVICES, systemctl } from './systemd.js';

const execFileAsync = promisify(execFile);

/** The npm `--prefix` this very binary lives under, so `orca update` reinstalls *itself* in place —
 *  no matter where it was globally installed (e.g. a www-data-owned prefix), and without the operator
 *  having to remember any `--prefix`. Returns null when run from a source checkout (no node_modules in
 *  the path), in which case we let npm use its default global prefix. */
function selfPrefix(): string | null {
  const here = fileURLToPath(import.meta.url); // <prefix>[/lib]/node_modules/orcasynth/dist/cli/update.js
  const idx = here.lastIndexOf('/node_modules/');
  if (idx === -1) return null;
  let base = here.slice(0, idx); // <prefix>/lib  (global, has lib/)  OR  <prefix>  (prefix-style install)
  if (basename(base) === 'lib') base = dirname(base);
  return base;
}

/** Latest published version of orcasynth from the npm registry. Uses the bare registry JSON endpoint
 *  (no npm spawn) so a version check is cheap and offline-tolerant (throws → caller reports it). */
async function checkLatest(fetchFn: typeof fetch = fetch): Promise<string> {
  const r = await fetchFn('https://registry.npmjs.org/orcasynth/latest');
  if (!r.ok) throw new Error(`registry returned ${r.status}`);
  const body = await r.json() as { version?: string };
  if (!body.version) throw new Error('registry returned no version');
  return body.version;
}

export interface UpdateDeps {
  fetch?: typeof fetch;
  current: string;
  /** Run the global install. Injected for tests; defaults to `npm i -g orcasynth@latest`. */
  install?: () => Promise<void>;
  /** Restart running services after a successful install. */
  restart?: (env: NodeJS.ProcessEnv) => Promise<void>;
}

export interface UpdateResult { updated: boolean; from: string; to: string }

/** Check npm for a newer release; if there is one, install it and restart the (running) services so
 *  the new binary takes over. The DB migrates itself on the next boot (openDb runs additive
 *  migrations), so no migration step is needed here. Returns what happened for the menu to report. */
export async function update(env: NodeJS.ProcessEnv, deps: UpdateDeps): Promise<UpdateResult> {
  const fetchFn = deps.fetch ?? fetch;
  const latest = await checkLatest(fetchFn);
  if (!isNewer(latest, deps.current)) return { updated: false, from: deps.current, to: latest };

  const install = deps.install ?? (async () => {
    const prefix = selfPrefix();
    await execFileAsync('npm', ['install', '-g', 'orcasynth@latest', ...(prefix ? ['--prefix', prefix] : [])]);
  });
  await install();

  // A box provisioned by `orca install` is systemd-managed — restart those units (sudo when not root).
  // A plain launcher install has no install.json — fall back to stop/start of our own spawned daemon.
  const restart = deps.restart ?? (async (e) => {
    if (readInstallInfo()) {
      const r = await systemctl('restart', ...SERVICES);
      if (r.code !== 0) throw new Error(`systemctl restart failed (code ${r.code})`);
      return;
    }
    await stop(e);
    await start(e, { version: latest });
  });
  await restart(env);

  return { updated: true, from: deps.current, to: latest };
}
