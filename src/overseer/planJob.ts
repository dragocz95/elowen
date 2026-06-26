import { randomBytes } from 'node:crypto';
import type { Phase } from './planner.js';

export type PlanJobStatus = 'planning' | 'done' | 'failed';
export interface PlanJob {
  id: string; epicId: string | null; goal: string; projectId: number; exec?: string; autoModel?: boolean;
  /** Optional short mission name → epic title. Empty/absent falls back to the goal, so the epic title
   *  is never blank. The full goal always lands in the epic description regardless. */
  name?: string;
  dryRun: boolean; engage?: { autonomy: string; maxSessions: number; preserveReviewBudget?: boolean };
  /** How many phases the mission may run in parallel — drives the Pilot's parallelism guidance at PLAN
   *  time, independent of `engage`. Set even when planning without immediate engage ("plan now, engage
   *  later"), so the planned DAG matches the intended concurrency. Defaults to 1. */
  maxSessions?: number;
  /** Per-task GitHub PR-native override, stamped onto the epic as a `pr:on`/`pr:off` label so this
   *  mission can opt in/out independently of the project/global default. Undefined/null = inherit. */
  prEnabled?: boolean | null;
  status: PlanJobStatus; phases: Phase[]; error?: string;
  /** tmux session of the Pilot agent in agent-mode planning, so the client can live-preview the
   *  planner's pane while it works. Unset for relay-mode planning (synchronous, no tmux). */
  sessionName?: string;
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

  create(input: { goal: string; name?: string; projectId: number; epicId: string | null; dryRun: boolean; exec?: string; autoModel?: boolean; engage?: { autonomy: string; maxSessions: number; preserveReviewBudget?: boolean }; prEnabled?: boolean | null; maxSessions?: number }): PlanJob {
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
  /** Record the Pilot's tmux session once it's spawned (agent-mode planning only). */
  setSession(id: string, sessionName: string): PlanJob | null {
    const j = this.jobs.get(id); if (!j) return null;
    j.sessionName = sessionName;
    return j;
  }
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
