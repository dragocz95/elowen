import { randomBytes } from 'node:crypto';
import type { Phase } from './planner.js';

export type PlanJobStatus = 'planning' | 'done' | 'failed';
export interface PlanJob {
  id: string; epicId: string | null; goal: string; projectId: number; exec?: string;
  dryRun: boolean; engage?: { autonomy: string; maxSessions: number };
  status: PlanJobStatus; phases: Phase[]; error?: string;
}

/** In-memory registry of async planning jobs. Ephemeral by design: a daemon restart drops jobs,
 *  which the API surfaces as failed (the user retries). Persistence is unnecessary — a plan job
 *  lives seconds (relay) to minutes (agent). */
/** How long a finished (done/failed) job is kept so the client can still read its result before it's
 *  pruned. Planning jobs are never pruned (they're in flight). 10 min covers the slowest agent plan. */
const TERMINAL_TTL_MS = 10 * 60_000;

export class PlanJobStore {
  private jobs = new Map<string, PlanJob>();
  /** Insertion time per job — used to prune long-finished jobs so the Map can't grow unbounded over
   *  a long-running daemon (a plan job is read once, then never again). */
  private created = new Map<string, number>();

  constructor(private now: () => number = Date.now) {}

  create(input: { goal: string; projectId: number; epicId: string | null; dryRun: boolean; exec?: string; engage?: { autonomy: string; maxSessions: number } }): PlanJob {
    this.prune();
    const job: PlanJob = { id: `pj-${randomBytes(5).toString('hex')}`, status: 'planning', phases: [], ...input };
    this.jobs.set(job.id, job);
    this.created.set(job.id, this.now());
    return job;
  }

  /** Drop done/failed jobs older than the TTL. In-flight ('planning') jobs are always kept. */
  private prune(): void {
    const cutoff = this.now() - TERMINAL_TTL_MS;
    for (const [id, job] of this.jobs) {
      if (job.status === 'planning') continue;
      if ((this.created.get(id) ?? 0) <= cutoff) { this.jobs.delete(id); this.created.delete(id); }
    }
  }
  get(id: string): PlanJob | null { return this.jobs.get(id) ?? null; }
  setPhases(id: string, phases: Phase[]): PlanJob | null {
    const j = this.jobs.get(id); if (!j) return null;
    j.phases = phases; j.status = 'done';
    return j;
  }
  fail(id: string, error: string): PlanJob | null {
    const j = this.jobs.get(id); if (!j) return null;
    j.status = 'failed'; j.error = error;
    return j;
  }
}
