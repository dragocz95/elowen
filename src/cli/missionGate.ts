import { openDb } from '../store/db.js';
import { MissionStore } from '../store/missionStore.js';
import { dbPath } from './paths.js';

/** Whether any mission is currently live (active or stalled), read FRESH from the daemon's DB — WAL lets
 *  a separate process read alongside the running daemon. The self-update path checks this TWICE: up front
 *  (the auto-update opt-in gate) and again right before the restart, so a mission that goes live during
 *  the npm install isn't killed by the restart. Single source for both checks. */
export function hasLiveMission(env: NodeJS.ProcessEnv): boolean {
  const db = openDb(dbPath(env));
  try {
    return new MissionStore(db).live().length > 0;
  } finally {
    db.close();
  }
}
