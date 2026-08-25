import { openDb } from '../store/db.js';
import { ConfigStore } from '../store/configStore.js';
import { dbPath } from '../shared/paths.js';
import { update, type UpdateResult } from './update.js';

/** What `elowen update --auto` (the hourly systemd timer) decided. It only upgrades when the operator
 *  opted in through config.autoUpdate. */
export type AutoUpdateOutcome =
  | { ran: false; reason: 'disabled' }
  | { ran: true; result: UpdateResult };

export interface AutoUpdateDeps {
  current: string;
  /** Reads the opt-in flag. Injected for tests; defaults to opening the daemon's SQLite DB. */
  gate?: () => { enabled: boolean };
  /** The actual updater. Injected for tests; defaults to the real npm install + restart. */
  runUpdate?: (env: NodeJS.ProcessEnv, deps: { current: string }) => Promise<UpdateResult>;
}

function readGate(env: NodeJS.ProcessEnv): { enabled: boolean } {
  const db = openDb(dbPath(env));
  let enabled: boolean;
  try {
    enabled = new ConfigStore(db).get().autoUpdate;
  } finally {
    db.close();
  }
  return { enabled };
}

/** Gate, then update. A disabled timer is a normal no-op, not a failure. */
export async function autoUpdate(env: NodeJS.ProcessEnv, deps: AutoUpdateDeps): Promise<AutoUpdateOutcome> {
  const { enabled } = (deps.gate ?? (() => readGate(env)))();
  if (!enabled) return { ran: false, reason: 'disabled' };
  const run = deps.runUpdate ?? update;
  return { ran: true, result: await run(env, { current: deps.current }) };
}
