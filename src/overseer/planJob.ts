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
export class PlanJobStore {
  private jobs = new Map<string, PlanJob>();

  create(input: { goal: string; projectId: number; epicId: string | null; dryRun: boolean; exec?: string; engage?: { autonomy: string; maxSessions: number } }): PlanJob {
    const job: PlanJob = { id: `pj-${randomBytes(5).toString('hex')}`, status: 'planning', phases: [], ...input };
    this.jobs.set(job.id, job);
    return job;
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
