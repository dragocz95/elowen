import type { BrainStore } from '../../store/brainStore.js';
import { processRegistry } from '../processRegistry.js';
import type { ElicitationRegistry } from '../elicitation.js';

/** The ONE fail-closed definition of "this conversation has WORK in flight", shared by every caller
 *  that would otherwise destroy or rewrite a live context — the detach-only stop and the idle reaper
 *  (SessionTeardownService, which must not kill running work) and the cold-start compaction
 *  (BrainTurnRunner, which must not summarize under a turn, a parked question or an undelivered
 *  result). Two hand-maintained copies of this rule is how they drift apart, and a drifted copy fails
 *  OPEN for exactly one caller. */

/** The subset of one live session the predicate reads. Kept structural so the quiescence policy does not
 *  depend on the session implementation or create a cycle back into the live registry. */
export interface QuiescenceLiveSession {
  session: {
    isStreaming: boolean;
    getSteeringMessages(): readonly unknown[];
    getFollowUpMessages(): readonly unknown[];
  };
  queuedSteer?: readonly unknown[];
  queuedFollowUp?: readonly unknown[];
  pendingCompactionEchoes?: readonly unknown[];
  deliveringUserEchoes?: readonly unknown[];
}

/** The subset of the live registry the predicate reads — structural, so tests drive it with fakes. */
interface QuiescenceSessions {
  get(sessionId: string): QuiescenceLiveSession | undefined;
  isParentAborting(sessionId: string): boolean;
  hasPendingAbort(sessionId: string): boolean;
  hasActiveChildren(sessionId: string): boolean;
}

export interface SessionQuiescenceDeps {
  store: Pick<BrainStore, 'getSubagentRuns' | 'getWorkflowRuns' | 'getGoal'>;
  sessions: QuiescenceSessions;
  elicitation: Pick<ElicitationRegistry, 'pendingForSession'>;
}

/** The direct children of `parentSessionId` that a parent abort (Esc / interruptQueued / stopSession)
 *  must SPARE: still-running detached/background delegates. Their results are durable in the inbox and
 *  are delivered independently of the parent's live turn (ensureLive respawns the parent if needed;
 *  restart reconcile sweeps any that die), so tearing them down on a parent stop would silently kill work
 *  the contract promised keeps running. Foreground blocking delegates are NOT spared — they belong to the
 *  interrupted turn. Same predicate the start() reconcile uses to decide auto-delivery. */
export function sparedChildSessionIds(
  store: Pick<BrainStore, 'getSubagentRuns' | 'getWorkflowRuns'>,
  parentSessionId: string,
): Set<string> {
  const spared = new Set(
    store.getSubagentRuns(parentSessionId)
      .filter((run) => run.status === 'running' && (run.background === true || run.autoDeliver === true))
      .map((run) => run.sessionId),
  );
  // A background workflow makes the same promise a detached delegate does, so its still-running NODE
  // sessions are spared on the same terms. Without this the engine correctly declined to cancel the
  // workflow while the abort cascade tore down the very children it was running in.
  for (const run of store.getWorkflowRuns(parentSessionId)) {
    if (run.status !== 'running' || run.background !== true) continue;
    for (const node of run.nodes) {
      if (node.status === 'running' && node.sessionId) spared.add(node.sessionId);
    }
  }
  return spared;
}

/** Whether this conversation has WORK in flight — a running turn, anything queued behind it, a parked
 *  question, a still-running child/workflow/background job, or an armed goal continuation. Deliberately
 *  FAIL-CLOSED: every uncertain signal counts as busy, because each caller either destroys a live
 *  runtime or rewrites its context when this answers false — the cost of a false "quiet" is killed or
 *  summarized-away work, while the cost of a false "busy" is a runtime that lives (or a context that
 *  stays fat) one turn longer. A session with no live record reports NO work: there is nothing live to
 *  protect, and a caller that additionally needs the record to exist (the compaction does; the teardown
 *  does not) checks that itself. */
export function sessionHasWorkInFlight(d: SessionQuiescenceDeps, sessionId: string): boolean {
  const live = d.sessions.get(sessionId);
  if (!live) return false;
  if (live.session.isStreaming) return true;
  if (d.sessions.isParentAborting(sessionId) || d.sessions.hasPendingAbort(sessionId)) return true;
  if (live.session.getSteeringMessages().length > 0 || live.session.getFollowUpMessages().length > 0) return true;
  if (live.queuedSteer?.length || live.queuedFollowUp?.length) return true;
  if (live.pendingCompactionEchoes?.length || live.deliveringUserEchoes?.length) return true;
  if (d.elicitation.pendingForSession(sessionId) !== null) return true;
  // Foreground children plus the detached/background delegates and workflow nodes that deliver their
  // results back INTO this conversation — tearing the parent down would strand every one of them.
  if (d.sessions.hasActiveChildren(sessionId) || sparedChildSessionIds(d.store, sessionId).size > 0) return true;
  if (processRegistry.runningJobCountForSession(sessionId) > 0) return true;
  // An active goal re-prompts this very session from a timer, so it is work in flight even between turns.
  if (d.store.getGoal(sessionId)?.status === 'active') return true;
  return false;
}
