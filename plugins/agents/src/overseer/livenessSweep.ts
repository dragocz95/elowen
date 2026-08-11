import { classifySession } from './sessionInfo.js';
import type { DecisionQueue, DecisionResult } from './decisionQueue.js';
import type { PaneActivityTracker } from './paneActivity.js';

/** A worker's pane unchanged this long → it may be wedged; wake the overseer to look. */
export const WORKER_IDLE_MS = 300_000; // 5 min
/** An overseer's OWN pane unchanged this long while it holds pending decisions → it's stuck, not just
 *  thinking; escalate them. Higher than a worker's bar: a premature overseer escalation hands a
 *  half-decided thing to a human (the very bug this avoids), and overseer reasoning is legitimately longer. */
export const OVERSEER_IDLE_MS = 600_000; // 10 min
/** Don't escalate a dead overseer's pending decisions until it's been gone this long — gives the overseer
 *  watchdog (re-parks a missing overseer every 60 s) a chance to recover first. */
export const DECISION_GRACE_MS = 90_000;
/** Absolute sanity backstop: escalate a decision that's sat this long no matter what — the one hole the
 *  pane-activity signal can't see is a TUI that keeps animating while its poll loop is dead. Deliberately
 *  very high so it never fires on a genuinely-thinking overseer; the pane-idle rule above is the real one. */
export const DECISION_HARD_MS = 1_800_000; // 30 min
/** How often the sweep runs from the daemon loop. */
export const DECISION_SWEEP_MS = 30_000;
/** A still-working worker gets a routine PROGRESS check this often — the overseer glances and may steer it,
 *  but never escalates a healthy agent. The single cadence knob (gated by `overseerExec`; 0 disables). */
export const PROGRESS_REVIEW_MS = 900_000; // 15 min
/** Tail of pane lines captured for the change-detection hash (matches the deriver's window). */
const PANE_TAIL = 60;

/** What to do with the overseer's verdict on a worker 'check'. */
export type CheckAction =
  | { type: 'noop' }              // false alarm (still working) or mission torn down — leave it
  | { type: 'nudge'; text: string } // wedge poke — delivered AND counted against the nudge budget
  | { type: 'steer'; text: string } // progress course-correction — delivered, NOT counted, NEVER escalated
  | { type: 'restart' }           // kill + relaunch the worker
  | { type: 'escalate' };         // hand to a human

/** Map a 'check' verdict to an action. Pure (no effects) so the mapping is unit-testable; the caller
 *  performs it and owns the nudge budget. Drain (mission gone) and a slow-then-answered overseer both
 *  reduce to no-op so a torn-down mission's worker is never disturbed.
 *  - reason 'idle' (wedge): after `nudgeMax` nudges a fresh nudge becomes an escalation; a bare reject
 *    escalates too — a hung agent eventually reaches a human.
 *  - reason 'progress' (routine glance at a WORKING agent): a message just steers it (no budget, no
 *    escalation), and anything ambiguous (bare reject, fumbled flags, timeout) leaves it alone — a healthy
 *    agent must never be handed to a human over a routine check. */
export function checkAction(verdict: DecisionResult, opts: { reason: 'idle' | 'progress'; missionLive: boolean; nudges: number; nudgeMax: number }): CheckAction {
  if (!opts.missionLive || verdict.rationale === 'mission disengaged') return { type: 'noop' };
  if (verdict.approve) return { type: 'noop' };
  const text = verdict.message?.trim();
  if (opts.reason === 'progress') {
    if (text) return { type: 'steer', text };
    if (verdict.restart) return { type: 'restart' };
    return { type: 'noop' };
  }
  if (text) return opts.nudges >= opts.nudgeMax ? { type: 'escalate' } : { type: 'nudge', text };
  if (verdict.restart) return { type: 'restart' };
  return { type: 'escalate' };
}

export interface AgentLivenessDeps {
  tmux: { list(): Promise<string[]>; capturePane(session: string, tail: number): Promise<string> };
  queue: DecisionQueue;
  tracker: PaneActivityTracker;
  /** Current epoch ms (injected for testability). */
  now: number;
  /** Per-mission "overseer first seen dead at" epoch ms — owned by the caller, persisted across sweeps
   *  so the grace window measures continuous absence. Mutated in place. */
  deadSince: Map<string, number>;
  /** Sessions with a `check` decision already awaiting the overseer — guards against re-enqueuing every
   *  tick while the worker's pane stays static. The sweep adds/removes around `checkWorker`. */
  inflightChecks: Set<string>;
  /** Per-session epoch ms of the last enqueued check (either reason) — throttles the routine progress
   *  review and is seeded on first sight so a fresh agent gets a full interval before its first review.
   *  Owned by the caller, persisted across sweeps, mutated in place. */
  lastProgressAt: Map<string, number>;
  /** Resolve the task a worker session runs, or null (no task row → skip, like the deriver). */
  sessionTaskId: (session: string) => string | null;
  /** The agent program for a worker session, or null. */
  programFor: (session: string) => string | null;
  /** True when the pane shows a structured prompt the deriver already handles (needs_input) — not a wedge. */
  hasPrompt: (content: string, program: string) => boolean;
  /** Wake the overseer about a worker: enqueue a 'check' (reason 'idle' = wedged, 'progress' = routine
   *  glance at a working agent) and act on the verdict. The sweep owns the inflight guard around it. */
  checkWorker: (session: string, taskId: string, snapshot: string, idleMin: number, reason: 'idle' | 'progress') => Promise<void>;
  workerIdleMs: number;
  overseerIdleMs: number;
  graceMs: number;
  hardMs: number;
  /** How long a working worker may run between routine progress checks; 0 disables them entirely. */
  progressReviewMs: number;
}

/**
 * One universal agent-liveness sweep. The signal is pane-content change (see `PaneActivityTracker`):
 * a working agent's screen keeps changing, a wedged one goes static. Per role:
 *  - **worker** idle past the bar (and not sitting on a prompt the deriver owns) → wake the overseer
 *    with a wedge `check`; a still-working worker instead gets a throttled routine `progress` check.
 *  - **overseer** with pending decisions: escalate them only when it's genuinely unsupervised — its
 *    session dead past grace, OR its own pane static past the idle bar (wedged) — never just because it's
 *    thinking. A high absolute backstop covers the animating-but-not-polling edge case.
 *  - **pilot / advisor** → skipped.
 * Replaces the old fixed wall-clock decision timeout; one sweep, no parallel liveness system.
 */
export async function sweepAgentLiveness(d: AgentLivenessDeps): Promise<{ escalated: string[]; checked: string[] }> {
  const sessions = (await d.tmux.list()).filter((s) => s.startsWith('elowen-'));
  const escalated: string[] = [];
  const checked: string[] = [];
  // Idle ms of each LIVE overseer session, keyed by mission — consumed by the pending-decision pass below.
  const overseerIdle = new Map<string, number>();

  for (const name of sessions) {
    const info = classifySession(name);
    if (info.role === 'pilot' || info.role === 'advisor') continue;
    const content = await d.tmux.capturePane(name, PANE_TAIL);
    const idle = d.tracker.seen(name, content, d.now);
    // Empty capture = the session vanished between list and capture — the dead-session stuck detector's
    // domain, never act on it here (acting would "restart" a corpse).
    if (idle === null) { d.tracker.forget(name); d.lastProgressAt.delete(name); continue; }

    if (info.role === 'overseer') {
      if (info.missionId) overseerIdle.set(info.missionId, idle);
      continue; // overseer escalation is decided against the pending queue below
    }
    // worker — two mutually-exclusive triggers off the same idle clock:
    //  - idle past the bar (static pane) → WEDGE check ('idle'): may nudge / restart / escalate.
    //  - still working (idle under the bar) → a throttled PROGRESS check ('progress'): a routine glance
    //    where the overseer may steer it but never escalates a healthy agent.
    const taskId = d.sessionTaskId(name); if (!taskId) continue;
    const program = d.programFor(name); if (!program) continue;
    if (d.hasPrompt(content, program)) continue;     // structured prompt → needs_input, deriver owns it
    if (d.inflightChecks.has(name)) continue;          // a check is already awaiting the overseer
    const reason: 'idle' | 'progress' = idle >= d.workerIdleMs ? 'idle' : 'progress';
    if (reason === 'progress') {
      if (d.progressReviewMs <= 0) continue;           // routine review disabled (e.g. no overseer exec)
      const last = d.lastProgressAt.get(name);
      // First sight → start the clock and let it work a full interval before its first review.
      if (last === undefined) { d.lastProgressAt.set(name, d.now); continue; }
      if (d.now - last < d.progressReviewMs) continue; // not due yet
    }
    d.lastProgressAt.set(name, d.now);                 // reset cadence on EITHER trigger (no stale re-fire)
    d.inflightChecks.add(name);
    checked.push(name);
    void d.checkWorker(name, taskId, content, Math.floor(idle / 60_000), reason).finally(() => d.inflightChecks.delete(name));
  }

  // Escalate unanswered decisions for missions whose overseer is genuinely unsupervised.
  const pending = d.queue.pending();
  const byMission = new Map<string, typeof pending>();
  for (const e of pending) { const l = byMission.get(e.missionId) ?? []; l.push(e); byMission.set(e.missionId, l); }
  for (const [missionId, entries] of byMission) {
    const idle = overseerIdle.get(missionId);
    if (idle === undefined) {
      // Overseer session not live → dead. Wait out the grace window (watchdog may re-park).
      const since = d.deadSince.get(missionId) ?? d.now;
      d.deadSince.set(missionId, since);
      if (d.now - since >= d.graceMs) {
        for (const e of entries) if (d.queue.timeout(missionId, e.id)) escalated.push(e.id);
        d.deadSince.delete(missionId);
      }
      continue;
    }
    d.deadSince.delete(missionId);
    if (idle >= d.overseerIdleMs) {
      // Alive but its pane has been static past the bar → wedged. Escalate its pending to a human.
      for (const e of entries) if (d.queue.timeout(missionId, e.id)) escalated.push(e.id);
    } else {
      // Alive and working (pane changing): never escalate for thinking — only the absolute backstop.
      for (const e of entries) if (d.now - e.enqueuedAt >= d.hardMs && d.queue.timeout(missionId, e.id)) escalated.push(e.id);
    }
  }
  // Prune dead-clocks for missions that drained/answered since the last sweep.
  for (const missionId of d.deadSince.keys()) if (!byMission.has(missionId)) d.deadSince.delete(missionId);

  return { escalated, checked };
}
