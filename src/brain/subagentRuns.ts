import type { BrainStore } from '../store/brainStore.js';
import { laterChildRunSpeaks, type BrainSubagentRun } from '../store/brainDelegationStore.js';
import type { BrainEvent, SubagentUpdate } from './events.js';
import type { ChildClaimSource } from './session/liveRegistry.js';
import { recordSubagentFinishMarker } from './service/sessionEvents.js';

/** Which of two calls on one child speaks for it, ordered by rowid — insertion order, because a
 *  boot-claimed recovery keeps the pause's `updated_at` and the timestamp therefore cannot decide. */
export function preferChildRun<T extends { status: BrainSubagentRun['status']; rowid: number }>(current: T, candidate: T): T {
  const later = candidate.rowid > current.rowid ? candidate : current;
  const earlier = later === candidate ? current : candidate;
  return laterChildRunSpeaks(earlier, later) ? later : earlier;
}

/** The ONE row per child a one-row-per-child view shows, in the order the store returned them.
 *
 *  `active` is the durable liveness answer (BrainStore.activeDelegationChildIds plus whatever the live
 *  registry already claims). Filtering FIRST matters: a row whose display state is still `running` while
 *  its lifecycle is long terminal — its final upsert never landed — is exactly what the filter hides, and
 *  hiding it must not take a finished sibling row down with it; the child WAS finished, and that is what
 *  the view should say. */
export function speakingChildRuns<T extends { sessionId: string; status: BrainSubagentRun['status']; rowid: number }>(
  runs: readonly T[],
  active: ReadonlySet<string>,
): T[] {
  const speaking = new Map<string, T>();
  for (const run of runs) {
    if (run.status === 'running' && !active.has(run.sessionId)) continue;
    const current = speaking.get(run.sessionId);
    speaking.set(run.sessionId, current ? preferChildRun(current, run) : run);
  }
  return runs.filter((run) => speaking.get(run.sessionId) === run);
}

/** The status of ONE child as a one-row-per-child view shows it, folded across every call on it with
 *  {@link preferChildRun}. Undefined when this conversation has no run row naming that child. */
export function childRunStatus(runs: readonly BrainSubagentRun[], sessionId: string): BrainSubagentRun['status'] | undefined {
  let chosen: BrainSubagentRun | undefined;
  for (const run of runs) {
    if (run.sessionId !== sessionId) continue;
    chosen = chosen ? preferChildRun(chosen, run) : run;
  }
  return chosen?.status;
}

/** The delegated-child liveness registry, narrowed to what a progress update touches. */
export interface SubagentClaims {
  setChildRunning(parentSessionId: string, childSessionId: string, running: boolean, source?: ChildClaimSource): void;
}

/** Everything {@link recordSubagentProgress} needs from the surface that owns the conversation. The owner
 *  chat and a platform channel differ only in WHERE they read these from, which is exactly why the body
 *  below lives here instead of twice in their turn builders. */
export interface SubagentProgressSink {
  store: BrainStore;
  claims: SubagentClaims;
  /** The conversation the delegating turn runs as — the parent of every child named in an update. */
  sessionId: string;
  publish(event: BrainEvent): void;
}

/** Persist one delegated-child progress update, publish it to the parent's clients, keep the child's
 *  'progress' liveness claim in step, and drop the timeline's finish marker when the child settles.
 *
 *  Persist-first: the durable row is what a reconnect rebuilds the sidecar from, so a live event must
 *  never advertise a state the store refused. What is published is the row as it was READ BACK, so the
 *  wire, the store and a later hydration cannot disagree.
 *
 *  Every state written here is the CALL's own and is written honestly — a continuation that returned is
 *  recorded as returned. A steered continuation used to be persisted as still running so that the
 *  per-child views would not mark the whole child complete; nothing ever emitted for that call again, so
 *  the lie was permanent, and both the rail and the model-facing reminder kept a finished follow-up
 *  frozen at one second. Choosing between a child's calls belongs to the views ({@link preferChildRun}),
 *  not to the record of what happened. */
export function recordSubagentProgress(sink: SubagentProgressSink, update: SubagentUpdate): boolean {
  const { store, claims, sessionId, publish } = sink;
  // Read the child's prior status BEFORE the upsert, so the finish marker lands once on the
  // running→terminal transition (upsertSubagentRun rewrites the row and returns true even for a
  // repeated 'done'). Only a terminal update can ever produce a marker, so skip the read otherwise.
  const terminal = update.status === 'done' || update.status === 'error';
  const before = terminal ? childRunStatus(store.getSubagentRuns(sessionId), update.sessionId) : undefined;
  if (!store.upsertSubagentRun(sessionId, update, update.status)) return false;
  const runs = store.getSubagentRuns(sessionId);
  const persisted = runs.find((run) => run.toolCallId === update.id);
  if (!persisted) return false;
  const { toolCallId: id, ...state } = persisted;
  const published: SubagentUpdate = { id, ...state };
  // As the 'progress' source: this tracks the plugin's progress ROW, not the child's actual run (that
  // claim belongs to begin/endDelegatedCall). A DelegateContinue that steered into a running child
  // settles its OWN progress claim while the child stays live under the actual call claim. UI state and
  // liveness ownership are deliberately separate here.
  claims.setChildRunning(sessionId, published.sessionId, update.status === 'running', 'progress');
  publish({ type: 'subagent', ...published });
  // The marker announces the CHILD finishing, not one call on it: while another call of the same child
  // is still running there is nothing to announce, and saying otherwise marks a sub-agent complete that
  // then "restarts" on its next progress event. Both sides of the transition are therefore the child's
  // folded status, not this row's.
  recordSubagentFinishMarker(store, sessionId, publish, before, {
    ...published,
    status: childRunStatus(runs, published.sessionId) ?? published.status,
  });
  return true;
}
