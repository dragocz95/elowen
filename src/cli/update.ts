import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isNewer } from './version.js';
import { start, stop } from './launcher.js';

const execFileAsync = promisify(execFile);

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

  const install = deps.install ?? (async () => { await execFileAsync('npm', ['install', '-g', 'orcasynth@latest']); });
  await install();

  const restart = deps.restart ?? (async (e) => {
    await stop(e);
    await start(e, { version: latest });
  });
  await restart(env);

  return { updated: true, from: deps.current, to: latest };
}
