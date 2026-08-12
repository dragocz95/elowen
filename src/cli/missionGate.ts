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
  // openDb applies the core schema + additive migrations; on a corrupted DB that itself can throw.
  // An unopenable DB leaves the live set UNKNOWN → fail closed (see below).
  let db: ReturnType<typeof openDb>;
  try { db = openDb(path); } catch { return true; }
  try {
    // Inline query (the MissionStore class lives in the agents plugin now; this is a separate CLI
    // process with no plugin registry). Same live-set semantics as the plugin store's live(): active
    // missions plus stalled ones still waiting on a human. The table may predate the plugin's first
    // migration on a brand-new DB — no table means no mission has ever run.
    try {
      const row = db.prepare("SELECT COUNT(*) AS n FROM missions WHERE state IN ('active','stalled')").get() as { n: number };
      return row.n > 0;
    } catch (error) {
      // ONLY a missing table proves "no mission has ever run". Any other failure (corrupt schema,
      // failed read) leaves the live set UNKNOWN — and this gate exists to stop a restart from killing
      // a running mission, so unknown fails CLOSED: report a live mission and let the update wait.
      if (error instanceof Error && /no such table/i.test(error.message)) return false;
      return true;
    }
  } finally {
    db.close();
  }
}
