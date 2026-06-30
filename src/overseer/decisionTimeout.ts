import type { DecisionQueue } from './decisionQueue.js';

/** Don't escalate a queued decision until its overseer has been dead this long — gives the overseer
 *  watchdog (which re-parks a missing overseer every 60 s) a chance to recover before bothering a human. */
export const DECISION_GRACE_MS = 90_000;
/** Absolute backstop: escalate a decision that has sat unanswered this long even while its overseer
 *  session is alive — guards against a wedged-but-present overseer that never polls/answers. */
export const DECISION_HARD_MS = 600_000;
/** How often the liveness sweep runs from the daemon loop. */
export const DECISION_SWEEP_MS = 30_000;

export interface DecisionTimeoutDeps {
  queue: DecisionQueue;
  /** Live `orca-overseer-<missionId>` session names (the same set `reconcileOverseers` derives). */
  liveSessions: Set<string>;
  /** Current epoch ms (injected for testability). */
  now: number;
  /** Per-mission "overseer first seen dead at" epoch ms — owned by the caller and persisted across
   *  sweeps so the grace window measures continuous absence, not just this tick. Mutated in place. */
  deadSince: Map<string, number>;
  graceMs: number;
  hardMs: number;
}

/**
 * Liveness-gated escalation of unanswered overseer decisions. Replaces the old per-enqueue wall-clock
 * deadline, which escalated a slow-but-alive overseer (e.g. a heavy review under claude opus) as if it
 * had vanished. The rule per mission with pending decisions:
 *  - overseer ALIVE → it's working its FIFO; escalate only entries past the absolute hard ceiling.
 *  - overseer DEAD past the grace window (watchdog didn't re-park in time) → escalate ALL its pending.
 * `deadSince` is pruned for missions that no longer have pending decisions. Returns escalated ids.
 */
export function sweepDecisionTimeouts(d: DecisionTimeoutDeps): { escalated: string[] } {
  const pending = d.queue.pending();
  const byMission = new Map<string, typeof pending>();
  for (const e of pending) {
    const list = byMission.get(e.missionId) ?? [];
    list.push(e);
    byMission.set(e.missionId, list);
  }
  const escalated: string[] = [];
  for (const [missionId, entries] of byMission) {
    const alive = d.liveSessions.has(`orca-overseer-${missionId}`);
    if (alive) {
      d.deadSince.delete(missionId);
      for (const e of entries) {
        if (d.now - e.enqueuedAt >= d.hardMs && d.queue.timeout(missionId, e.id)) escalated.push(e.id);
      }
      continue;
    }
    // Dead: start (or keep) the grace clock; only escalate once it's been continuously dead past grace.
    const since = d.deadSince.get(missionId) ?? d.now;
    d.deadSince.set(missionId, since);
    if (d.now - since >= d.graceMs) {
      for (const e of entries) { if (d.queue.timeout(missionId, e.id)) escalated.push(e.id); }
      d.deadSince.delete(missionId);
    }
  }
  // Prune dead-clocks for missions that drained/answered since the last sweep.
  for (const missionId of d.deadSince.keys()) {
    if (!byMission.has(missionId)) d.deadSince.delete(missionId);
  }
  return { escalated };
}
