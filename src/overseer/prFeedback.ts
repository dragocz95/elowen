import type { MissionPrStore } from '../store/missionPrStore.js';
import type { MissionStore } from '../store/missionStore.js';
import type { EventBus } from '../api/sse.js';
import type { MissionGit } from './missionGit.js';
import { logger } from '../shared/logger.js';

const log = logger('pr-feedback');

/** How many auto fix rounds a mission's PR may consume before escalating to a human. Matches the spirit
 *  of taskStore's REVIEW_FIX budget — it bounds the Codex↔Orca review ping-pong. */
const PR_FIX_BUDGET = 2;

export interface PrFeedbackDeps {
  prs: MissionPrStore;
  missions: MissionStore;
  missionGit: MissionGit;
  bus: Pick<EventBus, 'publish'>;
  /** Plan a fix from the aggregated PR feedback AND re-engage the mission once the phases are pinned.
   *  Bound in bootstrap to planJobs.create (with an `engage` flag, so finalizePlanJob re-engages only
   *  after the pilot has actually appended the phases — never before, which would race the mission into
   *  disengaging with nothing to do). Returns true when planning started; false keeps the budget unspent
   *  (relay-only with no pilot, or a failed start). */
  replan: (input: { epicId: string; goal: string; exec?: string }) => Promise<boolean>;
}

/**
 * Poll every mission with an open PR for fresh, actionable review feedback. Within the fix budget a
 * round routes the aggregated feedback through the pilot (which plans 1..N fix phases on the original
 * mission's exec) and re-engages the mission so an agent applies them in the worktree — the next
 * commit/push then updates the PR. Once the budget is spent the mission is parked as `stalled` for a
 * human (no further auto fixes). A merged/closed PR drops out of the watch set via ingestReviews.
 * Returns the mission ids that were re-engaged this sweep. Cheap when there are no open PRs.
 */
export async function sweepPrFeedback(d: PrFeedbackDeps): Promise<string[]> {
  const reengaged: string[] = [];
  for (const rec of d.prs.withOpenPr()) {
    const res = await d.missionGit.ingestReviews(rec.mission_id);
    if (res.action !== 'feedback') continue;
    const mission = d.missions.get(rec.mission_id);
    if (!mission) continue;

    const rounds = d.prs.get(rec.mission_id)?.fix_rounds ?? 0;
    if (rounds >= PR_FIX_BUDGET) {
      d.missions.setState(rec.mission_id, 'stalled');
      d.bus.publish({ type: 'mission', missionId: rec.mission_id, state: 'stalled' });
      log.info(`PR feedback: mission ${rec.mission_id} exhausted the fix budget (${rounds}) — escalating to a human`);
      continue;
    }

    const started = await d.replan({ epicId: mission.epic_id, goal: res.feedback, exec: res.exec });
    if (!started) continue; // budget stays un-spent — nothing was planned
    d.prs.bumpFixRounds(rec.mission_id);
    reengaged.push(rec.mission_id); // replan re-engages once its phases are pinned (engage flag)
  }
  return reengaged;
}
