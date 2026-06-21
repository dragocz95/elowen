import type { Db } from './db.js';
import type { MissionState } from './types.js';

export type { MissionState };

export interface Mission {
  id: string; epic_id: string; autonomy: string; max_sessions: number;
  state: MissionState;
}

// Explicit column list everywhere: a pre-existing DB may still carry the dropped `cleared_guardrails`
// column, so `SELECT *` would leak it — name the columns we actually map instead.
const COLS = 'id,epic_id,autonomy,max_sessions,state';

export class MissionStore {
  constructor(private db: Db) {}

  create(m: Omit<Mission, 'state'>): Mission {
    this.db.prepare(
      `INSERT INTO missions (id,epic_id,autonomy,max_sessions,state)
       VALUES (@id,@epic_id,@autonomy,@max_sessions,'active')`
    ).run({ ...m });
    return this.get(m.id)!;
  }

  get(id: string): Mission | null {
    return (this.db.prepare(`SELECT ${COLS} FROM missions WHERE id=?`).get(id) as Mission | undefined) ?? null;
  }

  active(): Mission[] {
    return this.db.prepare(`SELECT ${COLS} FROM missions WHERE state='active'`).all() as Mission[];
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
