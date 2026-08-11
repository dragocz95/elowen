import { existsSync } from 'node:fs';
import { openDb } from '../store/db.js';
import { dbPath } from '../shared/paths.js';

/** Whether any mission is currently live (active or stalled), read FRESH from the daemon's DB — WAL lets
 *  a separate process read alongside the running daemon. The self-update path checks this TWICE: up front
 *  (the auto-update opt-in gate) and again right before the restart, so a mission that goes live during
 *  the npm install isn't killed by the restart. `elowen setup` asks the same question before it replaces
 *  an unhealthy daemon. Single source for every one of those checks. */
export function hasLiveMission(env: NodeJS.ProcessEnv): boolean {
  // openDb CREATES the DB (and its schema) when the file is missing. `elowen setup` asks this gate before
  // the daemon has ever booted, usually as the invoking user rather than the service user, so opening it
  // here would leave a wrongly-owned DB behind for the daemon. No DB means nothing has ever run: no mission.
  const path = dbPath(env);
  if (!existsSync(path)) return false;
  const db = openDb(path);
  try {
    // Inline query (the MissionStore class lives in the agents plugin now; this is a separate CLI
    // process with no plugin registry). Same live-set semantics as the plugin store's live(): active
    // missions plus stalled ones still waiting on a human. The table may predate the plugin's first
    // migration on a brand-new DB — no table means no mission has ever run.
    try {
      const row = db.prepare("SELECT COUNT(*) AS n FROM missions WHERE state IN ('active','stalled')").get() as { n: number };
      return row.n > 0;
    } catch { return false; }
  } finally {
    db.close();
  }
}
