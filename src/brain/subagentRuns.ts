import type { BrainStore } from '../store/brainStore.js';
import type { BrainSubagentRun } from '../store/brainDelegationStore.js';
import type { BrainEvent, SubagentUpdate } from './events.js';
import type { ChildClaimSource } from './session/liveRegistry.js';
import { recordSubagentFinishMarker } from './service/sessionEvents.js';

/** One run row is one CALL on a child, never the child itself. A child routinely carries two at once: the
 *  original Delegate, still working, and a DelegateContinue whose message was steered into that running
 *  turn and which therefore returns within a second. Any view that shows one row per child has to choose
 *  between them, and this is that choice — a call still running outranks one that already returned, and
 *  among equals the newest row wins (insertion order; a boot-claimed recovery keeps the pause's
 *  updated_at, so the timestamp cannot decide).
 *
 *  The alternative — letting whichever update landed last speak — is what froze a finished continuation
 *  on the CLI rail as a running sub-agent with no model and no elapsed time, and what reported a working
 *  child as finished when a recovering continuation followed a completed delegation. */
export function preferChildRun<T extends { status: BrainSubagentRun['status']; rowid: number }>(current: T, candidate: T): T {
  if (current.status === 'running' && candidate.status !== 'running') return current;
  if (candidate.status === 'running' && current.status !== 'running') return candidate;
  return candidate.rowid > current.rowid ? candidate : current;
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
