import { projectReviewDiff } from '../../integrations/projectFiles.js';
import { buildReviewContext } from '../../overseer/reviewContext.js';
import { snapshotTaskChanges } from '../../overseer/taskSnapshot.js';
import { logger } from '../../shared/logger.js';
import type { KeyedMutex } from '../../shared/keyedMutex.js';
import type { DecisionQueue } from '../../overseer/decisionQueue.js';
import type { Task } from '../../store/types.js';
import type { ServerDeps } from '../deps.js';

/** How many times an L3 mission auto-re-spawns a phase that the post-done review rejected before it
 *  gives up and escalates to a human. Mirrors the stuck detector's `maxRelaunch` (2) so the two
 *  bounded-retry loops behave consistently. */
const REVIEW_FIX_BUDGET = 2;

export interface ReviewServiceDeps {
  d: ServerDeps;
  log: ReturnType<typeof logger>;
  gitLock: KeyedMutex;
  decisionQueue: DecisionQueue;
  /** The checkout a mission's work lands in (worktree while live, else the project checkout). */
  checkoutPathFor(missionId: string | null, projectId: number): string;
  /** Filesystem path of a project (for the standalone-task snapshot). */
  pathFor(projectId: number): string;
}

export interface ReviewService {
  /** Release the dependents a phase's review gate was holding; returns the ids actually re-opened. */
  releaseGatedDependents(phaseId: string): string[];
  /** Handle a task's close: drive the post-done overseer review gate (mission phases) or snapshot a
   *  standalone task's change list. Called after the status flip + SSE publish, only on close. */
  onTaskClosed(id: string, existing: Task, opts: { outcome?: string; summary?: string }): Promise<void>;
}

/** The post-done review workflow — the heart of the autopilot close path. Gates a mission phase's
 *  direct dependents at close, hands the overseer the real diff, and applies the verdict (commit +
 *  release on approve; L3 self-heal or human escalation on reject). Extracted from the route handler
 *  so this delicate sequencing can be reasoned about and tested in isolation. */
export function createReviewService({ d, log, gitLock, decisionQueue, checkoutPathFor, pathFor }: ReviewServiceDeps): ReviewService {
  /** Release the dependents a phase's review gate was holding: clear this phase's `gatedby:<id>` hold
   *  and re-open each dependent that no OTHER review still gates (a DAG dependent can be held by several
   *  predecessors at once). Re-check 'blocked' so a human's manual change is never overridden. Single
   *  source of truth for both an agent-approved verdict and a human approval, so they behave
   *  identically. Returns the ids actually re-opened. */
  function releaseGatedDependents(phaseId: string): string[] {
    const reopened: string[] = [];
    for (const e of d.tasks.allDeps()) {
      if (e.depends_on_id !== phaseId) continue;
      const dep = d.tasks.get(e.task_id);
      if (!dep || !dep.labels.includes(`gatedby:${phaseId}`)) continue;
      d.tasks.removeLabel(dep.id, `gatedby:${phaseId}`);
      const stillGated = d.tasks.get(dep.id)!.labels.some((l) => l.startsWith('gatedby:'));
      if (!stillGated && dep.status === 'blocked') {
        d.tasks.setStatus(dep.id, 'open');
        d.bus.publish({ type: 'task', taskId: dep.id, status: 'open' });
        reopened.push(dep.id);
      }
    }
    return reopened;
  }

  async function onTaskClosed(id: string, existing: Task, opts: { outcome?: string; summary?: string }): Promise<void> {
    // Post-done review (opt-in): when a mission phase closes, let the parked overseer judge the
    // outcome before the next phase may run. This is a HARD sequential gate — the phase's direct
    // dependents are blocked synchronously at close (so the engine tick can't spawn them mid-review),
    // and only an approving verdict releases them. A reject verdict leaves them blocked,
    // so a bad result halts the mission for a human instead of rolling on. Default off, and only
    // active with an agent overseer configured.
    const cfg = d.config.get();
    if (existing.parent_id) {
      const mission = d.missions.activeForEpic(existing.parent_id) ?? undefined;
      // Tracks whether this close handed the phase to the overseer review gate. When it did, the
      // phase's worktree commit happens on the approving verdict (below); when it didn't, the close
      // is final and we commit right here — so a rejected phase never lands a commit.
      let reviewEnqueued = false;
      if (mission && cfg.autopilot.reviewOnDone && cfg.autopilot.overseerExec) {
        // Close the gate now: block every open direct dependent so no tick spawns it while the review
        // is pending. Track exactly which ones we gated — the verdict releases only these, never a
        // dependent left blocked by a different cause (e.g. an earlier review on another dep).
        const gated: string[] = [];
        for (const e of d.tasks.allDeps()) {
          if (e.depends_on_id !== id) continue;
          const dep = d.tasks.get(e.task_id);
          if (!dep) continue;
          // Gate a direct dependent when it is still 'open', OR when this very phase's earlier review
          // already gated it (an L3 self-heal re-close: the dependent is 'blocked' from the first round,
          // not 'open', so a status check alone would miss it and the mission would strand). The
          // `gatedby:<id>` marker records which review holds it, so the verdict releases only its own gate.
          const gatedByThis = dep.labels.includes(`gatedby:${id}`);
          if (dep.status === 'open' || gatedByThis) {
            if (dep.status !== 'blocked') { d.tasks.setStatus(dep.id, 'blocked'); d.bus.publish({ type: 'task', taskId: dep.id, status: 'blocked' }); }
            if (!gatedByThis) d.tasks.addLabel(dep.id, `gatedby:${id}`);
            gated.push(dep.id);
          }
        }
        // Nothing was gated → nothing downstream to hold back, so there is nothing to review. This is
        // the terminal/leaf phase: closing it also completes the mission, which drains the queue with a
        // synthetic 'mission disengaged' verdict. Reviewing it here would let that synthetic reject
        // resurrect a just-finished phase into an orphaned, mission-less 'open' state. Skip it.
        if (gated.length > 0) {
          reviewEnqueued = true;
          // Hand the overseer the REAL evidence — the working-tree changes — not just the agent's
          // self-reported summary, so the review judges the diff instead of rubber-stamping. Workers
          // don't commit, so `git diff HEAD` is the phase's actual change set. In PR-native mode the
          // agent edits the mission's worktree (and Orca commits each approved phase), so read the diff
          // THERE — the main checkout would show nothing. Without a worktree it's the project checkout,
          // where the diff is cumulative across the sequential mission.
          const reviewPath = checkoutPathFor(mission.id, existing.project_id);
          const { changedFiles, diff } = await projectReviewDiff(reviewPath);
          const reviewCtx = buildReviewContext({ title: existing.title, outcome: opts.outcome ?? '', summary: opts.summary ?? '', changedFiles, diff });
          void decisionQueue.enqueue(mission.id, 'review', reviewCtx)
            .then(async (verdict) => {
              // The mission may have torn down while the review was pending (manual disengage, shutdown):
              // the drain settles the queue with a synthetic reject. Never apply a verdict to a dead
              // mission — releasing or self-healing it would only orphan tasks under a mission that's gone.
              const live = d.missions.get(mission.id);
              if (!live || (live.state !== 'active' && live.state !== 'stalled')) return;
              const approved = verdict.approve;
              // Surface the verdict to the UI/timeline — otherwise the rationale dies in the overseer
              // pane and the user only sees an unexplained 'blocked'/'stalled'.
              d.bus.publish({ type: 'review', missionId: mission.id, taskId: id, approve: approved, rationale: verdict.rationale });
              if (approved) {
                // Commit the approved phase's work BEFORE the next phase ticks (the worktree in PR
                // mode, else the shared project checkout) so the next agent never edits it mid-commit.
                // Under the checkout lock so it can't interleave with the next agent's baseline read —
                // the snapshot below then has a stable base..HEAD that captures exactly this phase.
                await gitLock.run(reviewPath, async () => {
                  await d.missionGit?.commitPhase(mission.id, existing.title, reviewPath).catch((e) => log.error('phase commit failed', e));
                  await snapshotTaskChanges(d.tasks, id, reviewPath);
                });
                // Gate opens: release the gated dependents and resume so the next phase spawns promptly
                // rather than waiting up to the 90s interval. resumeStalled (not a bare tick) un-freezes
                // the mission if it stalled while the verdict was pending — otherwise the freeze would
                // swallow this tick and the approved work would never run.
                releaseGatedDependents(id);
                void d.engine.resumeStalled(mission.id).catch((e) => log.error('post-review resume failed', e));
                return;
              }
              // Rejected. L3 (full autonomy) self-heals: re-open the phase with the review
              // feedback so the agent fixes it, up to REVIEW_FIX_BUDGET times before escalating. L1/L2
              // (human-in-the-loop) leave it — the dependents stay gated for a human to resolve.
              // A `escalated` verdict (the overseer never answered — a timeout) is NOT a real reject:
              // it must wait for a human, never self-heal. Without this guard a slow/absent overseer
              // turned every phase into an infinite reopen loop. Check it BEFORE bumpReviewFix so a
              // timeout doesn't burn the self-heal budget either.
              const fresh = d.tasks.get(id);
              // Read autonomy from `live` (re-fetched above), not the close-time `mission` snapshot:
              // a re-engage between close and this verdict (e.g. a PR-feedback replan) may have changed
              // it, and the self-heal decision must follow the mission's CURRENT autonomy.
              if (fresh && !verdict.escalated && live.autonomy === 'L3' && d.tasks.bumpReviewFix(id) <= REVIEW_FIX_BUDGET) {
                // Pin the rejection as a single resume note so a multi-round reject loop refreshes it
                // instead of stacking duplicate feedback blocks onto the description.
                d.tasks.setResumeNote(id, `[Review rejected — previous attempt was not accepted]: ${verdict.rationale}\nFix the issue and close the task again.`);
                // Reap the worker if it outlived its task close, so the re-spawn doesn't collide with a
                // still-live `orca-<agent>` session ("duplicate session" → endless failed re-spawns).
                await d.engine.stopTask(id);
                d.tasks.setStatus(id, 'open'); // re-open so the engine tick re-spawns it (its deps are already satisfied)
                d.bus.publish({ type: 'task', taskId: id, status: 'open' });
                // Self-heal is autonomous continuation, not an escalation — resume (un-freeze if it
                // stalled in the verdict window) so the re-opened phase actually re-spawns.
                void d.engine.resumeStalled(mission.id).catch((e) => log.error('post-review self-heal resume failed', e));
              } else {
                // Not self-healed (overseer timeout, L1/L2 human-in-the-loop, or self-heal budget
                // spent): leave the phase closed and its dependents blocked for a human. Tick so the
                // mission flips to 'stalled' ("needs attention") now instead of reading 'active' until
                // the next 90s interval — the escalation must be visible, and the mission waits, never
                // disengages, until the human resolves it (approve-gate / re-run on the Escalations page).
                void d.engine.tick(mission.id).catch((e) => log.error('post-review escalation tick failed', e));
              }
            })
            // Fire-and-forget review must never crash the daemon — the verdict apply (or the enqueue
            // itself) can throw, so swallow-and-log instead of leaving an unhandled rejection.
            .catch((e) => log.error('review verdict apply failed', e));
        }
      }
      // When a phase's close is final (no review gate pending), commit its work now — the worktree in
      // PR mode, else the shared project checkout. The review path above commits on approval instead,
      // so a rejected phase never commits.
      if (mission && !reviewEnqueued) {
        const snapPath = checkoutPathFor(mission.id, existing.project_id);
        await gitLock.run(snapPath, async () => {
          await d.missionGit?.commitPhase(mission.id, existing.title, snapPath).catch((e) => log.error('phase commit failed', e));
          await snapshotTaskChanges(d.tasks, id, snapPath);
        });
      }
    } else {
      // A standalone task (no mission/worktree): its agent commits into the project checkout, so the
      // frozen change list is base..HEAD there. No-op when nothing was committed (empty snapshot).
      // Under the checkout lock so the range can't straddle a concurrent agent's commit on the same path.
      const snapPath = pathFor(existing.project_id);
      await gitLock.run(snapPath, () => snapshotTaskChanges(d.tasks, id, snapPath));
    }
  }

  return { releaseGatedDependents, onTaskClosed };
}
