import type { Db } from './db.js';
import type { MissionState } from './types.js';

export type { MissionState };

export interface Mission {
  id: string; epic_id: string; autonomy: string; max_sessions: number;
  cleared_guardrails: string[]; state: MissionState;
}

type MRow = Omit<Mission, 'cleared_guardrails'> & { cleared_guardrails: string };

const toMission = (r: MRow): Mission => ({ ...r, cleared_guardrails: r.cleared_guardrails ? r.cleared_guardrails.split(',').filter(Boolean) : [] });

export class MissionStore {
  constructor(private db: Db) {}

  create(m: Omit<Mission, 'state'>): Mission {
    this.db.prepare(
      `INSERT INTO missions (id,epic_id,autonomy,max_sessions,cleared_guardrails,state)
       VALUES (@id,@epic_id,@autonomy,@max_sessions,@cg,'active')`
    ).run({ ...m, cg: m.cleared_guardrails.join(',') });
    return this.get(m.id)!;
  }

  get(id: string): Mission | null {
    const r = this.db.prepare('SELECT * FROM missions WHERE id=?').get(id) as MRow | undefined;
    return r ? toMission(r) : null;
  }

  active(): Mission[] {
    return (this.db.prepare("SELECT * FROM missions WHERE state='active'").all() as MRow[]).map(toMission);
  }

  /** Missions the overseer should keep ticking: active ones plus 'stalled' ones (waiting on a
   *  human to unblock a child). A stalled mission resumes to 'active' on the tick after its
   *  blocker clears, so it must stay in the loop. */
  live(): Mission[] {
    return (this.db.prepare("SELECT * FROM missions WHERE state IN ('active','stalled')").all() as MRow[]).map(toMission);
  }

  setState(id: string, state: MissionState): void {
    this.db.prepare('UPDATE missions SET state=? WHERE id=?').run(state, id);
  }
}
