import type { Db } from './db.js';

/** PR-native bookkeeping for a mission: the dedicated branch + worktree it runs in, and — once opened
 *  — the GitHub PR's number/url/state plus the last review timestamp the feedback poller has ingested.
 *  Single source of truth for "what git/PR state belongs to this mission" (never task labels). */
export interface MissionPr {
  mission_id: string;
  branch: string;
  worktree: string;
  pr_number: number | null;
  pr_url: string | null;
  pr_state: string | null;     // open | merged | closed | null (not opened yet)
  last_review_ts: string | null;
}

const COLS = 'mission_id,branch,worktree,pr_number,pr_url,pr_state,last_review_ts';

export class MissionPrStore {
  constructor(private db: Db) {}

  /** Create the record for a freshly engaged mission, or return the existing one unchanged. Create is
   *  idempotent: re-engaging an epic (same mission id) must keep the original branch/worktree — a live
   *  worktree on disk must never be silently rebound to a new branch. */
  create(input: { mission_id: string; branch: string; worktree: string }): MissionPr {
    this.db.prepare(
      `INSERT INTO mission_pr (mission_id,branch,worktree)
       VALUES (@mission_id,@branch,@worktree)
       ON CONFLICT(mission_id) DO NOTHING`
    ).run({ ...input });
    return this.get(input.mission_id)!;
  }

  get(missionId: string): MissionPr | null {
    return (this.db.prepare(`SELECT ${COLS} FROM mission_pr WHERE mission_id=?`).get(missionId) as MissionPr | undefined) ?? null;
  }

  /** Record an opened PR's number, url and state. */
  setPr(missionId: string, pr: { number: number; url: string; state: string }): MissionPr | null {
    this.db.prepare('UPDATE mission_pr SET pr_number=?, pr_url=?, pr_state=? WHERE mission_id=?')
      .run(pr.number, pr.url, pr.state, missionId);
    return this.get(missionId);
  }

  /** Update just the PR lifecycle state (open → merged/closed), leaving number/url intact. */
  setPrState(missionId: string, state: string): MissionPr | null {
    this.db.prepare('UPDATE mission_pr SET pr_state=? WHERE mission_id=?').run(state, missionId);
    return this.get(missionId);
  }

  /** Stamp the timestamp of the newest review the feedback poller has already ingested (dedup). */
  setLastReviewTs(missionId: string, ts: string): MissionPr | null {
    this.db.prepare('UPDATE mission_pr SET last_review_ts=? WHERE mission_id=?').run(ts, missionId);
    return this.get(missionId);
  }

  remove(missionId: string): void {
    this.db.prepare('DELETE FROM mission_pr WHERE mission_id=?').run(missionId);
  }

  /** Records whose PR is still open — the working set the feedback poller scans for new reviews. */
  withOpenPr(): MissionPr[] {
    return this.db.prepare(`SELECT ${COLS} FROM mission_pr WHERE pr_state='open'`).all() as MissionPr[];
  }

  /** Records still needing attention in the UI: no PR yet (ready to open / verify failed) or an open
   *  PR — i.e. anything not merged/closed. Lets a completed-but-PR-pending mission keep surfacing the
   *  branch/PR affordance even after it has disengaged. */
  pending(): MissionPr[] {
    return this.db.prepare(`SELECT ${COLS} FROM mission_pr WHERE pr_state IS NULL OR pr_state NOT IN ('merged','closed')`).all() as MissionPr[];
  }
}
