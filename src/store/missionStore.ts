import type { Db } from './db.js';
import type { MissionState } from './types.js';

export type { MissionState };

export interface Mission {
  id: string; epic_id: string; autonomy: string; max_sessions: number;
  state: MissionState;
  /** The user who engaged the mission; null for legacy/system missions. Drives push-notification routing. */
  created_by: number | null;
}

// Explicit column list everywhere: a pre-existing DB may still carry the dropped `cleared_guardrails`
// column, so `SELECT *` would leak it — name the columns we actually map instead.
const COLS = 'id,epic_id,autonomy,max_sessions,state,created_by';

export class MissionStore {
  constructor(private db: Db) {}

  /** Create (engage) a mission, or re-activate an existing one with the same id. A mission id is
   *  `m-<epicId>`, so re-engaging an epic whose prior mission was disengaged/crashed would otherwise
   *  hit a UNIQUE violation — the row is left behind on disengage. Upsert resets it to 'active' and
   *  applies the new autonomy / max_sessions, making engage idempotent and re-engageable. */
  create(m: Omit<Mission, 'state' | 'created_by'> & { created_by?: number | null }): Mission {
    this.db.prepare(
      `INSERT INTO missions (id,epic_id,autonomy,max_sessions,state,created_by)
       VALUES (@id,@epic_id,@autonomy,@max_sessions,'active',@created_by)
       ON CONFLICT(id) DO UPDATE SET
         epic_id=excluded.epic_id, autonomy=excluded.autonomy,
         max_sessions=excluded.max_sessions, state='active'`
      // created_by is deliberately NOT updated on re-engage: the original engager stays the owner
      // (notification routing always also includes admins, so a different re-engager is still covered).
    ).run({ ...m, created_by: m.created_by ?? null });
    return this.get(m.id)!;
  }

  get(id: string): Mission | null {
    return (this.db.prepare(`SELECT ${COLS} FROM missions WHERE id=?`).get(id) as Mission | undefined) ?? null;
  }

  active(): Mission[] {
    return this.db.prepare(`SELECT ${COLS} FROM missions WHERE state='active'`).all() as Mission[];
  }

  /** The ACTIVE mission driving a given epic, or null. Single source for the `active().find(m =>
   *  m.epic_id === epicId)` lookup that the guide/ask/review/scheduler paths all need (a phase's
   *  parent_id IS its epic id; the mission id is `m-<epicId>`). */
  activeForEpic(epicId: string): Mission | null {
    return (this.db.prepare(`SELECT ${COLS} FROM missions WHERE state='active' AND epic_id=?`).get(epicId) as Mission | undefined) ?? null;
  }

  /** Missions the overseer should keep ticking: active ones plus 'stalled' ones (waiting on a
   *  human to unblock a child). A stalled mission resumes to 'active' on the tick after its
   *  blocker clears, so it must stay in the loop. */
  live(): Mission[] {
    return this.db.prepare(`SELECT ${COLS} FROM missions WHERE state IN ('active','stalled')`).all() as Mission[];
  }

  setState(id: string, state: MissionState): void {
    this.db.prepare('UPDATE missions SET state=? WHERE id=?').run(state, id);
  }
}
