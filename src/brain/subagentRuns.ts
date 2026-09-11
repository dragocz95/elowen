import type { BrainStore } from '../store/brainStore.js';
import { laterChildRunSpeaks, type BrainSubagentRun } from '../store/brainDelegationStore.js';
import type { BrainEvent, SubagentUpdate } from './events.js';
import { channelIdOf, isChannelSession } from './sessionId.js';
import type { ChildClaimSource, LiveSessionRegistry } from './session/liveRegistry.js';
import type { LiveBrain } from './session/liveBrain.js';
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
  /** What ONE delegated child actually runs on, as {@link delegatedChildIdentity} reads it. The second
   *  argument carries the update's own dispatch-time level, which the helper may use only where no live
   *  record exists. Wired by both surfaces that own a conversation; the record below persists only what
   *  this returns plus the update. */
  identityOf?(childSessionId: string, dispatch?: { thinkingLevel?: string; thinkingLabel?: string }): SubagentChildIdentity | undefined;
}

/** The model + reasoning effort one delegated child runs on, read at progress time. */
export interface SubagentChildIdentity {
  model?: string;
  thinkingLevel?: string;
  thinkingLabel?: string;
}

/** The child's OWN model and reasoning effort — the one authoritative read, shared by every surface that
 *  records a delegated progress row.
 *
 *  The LIVE record wins: it is what the child's turn actually acts on, post-clamp, after an explicit model
 *  change and after a respawn — and when it exists but reports NO level, that absence is the truth (the
 *  session runs on none), not a reason to dig for one — not even for the level the delegating plugin
 *  resolved at dispatch time, which a mid-call change or a ladder-less child model may have invalidated.
 *  Delegated children are channel sessions, so a registry read must cover BOTH maps — `.get()` (owner
 *  chats) alone never finds one, which is what made the first cut of this enrichment dead code for exactly
 *  the children it was written for. A child running in the sub-agent runner has no live record in this
 *  process at all; the durable delegated scope then stands in (because it is what the host stamps into
 *  every turn of that child, including a continuation), and only below THAT the dispatch-time level —
 *  the pre-spawn resolution a fresh Delegate still knows. A level read without a live ladder has no
 *  labels to translate it, so the raw level id is its own label rather than a name guessed from the parent. */
export function delegatedChildIdentity(
  store: Pick<BrainStore, 'getSession' | 'delegatedAccessFor'>,
  sessions: Pick<LiveSessionRegistry<LiveBrain>, 'get' | 'channelGet'>,
  childSessionId: string,
  dispatch?: { thinkingLevel?: string; thinkingLabel?: string },
): SubagentChildIdentity | undefined {
  const live = sessions.get(childSessionId)
    ?? (isChannelSession(childSessionId) ? sessions.channelGet(channelIdOf(childSessionId)) : undefined);
  // With a live record this process owns the truth; without one, scope first, then the dispatch level.
  const level = live
    ? (live.session as { thinkingLevel?: string } | undefined)?.thinkingLevel ?? live.thinkingLevel
    : store.delegatedAccessFor(childSessionId)?.thinkingLevel ?? dispatch?.thinkingLevel;
  const model = live ? live.model : store.getSession(childSessionId)?.model;
  if (!model && !level) return undefined;
  const dispatches = level !== undefined && level === dispatch?.thinkingLevel;
  return {
    ...(model ? { model } : {}),
    ...(level ? {
      thinkingLevel: level,
      thinkingLabel: live?.thinkingLabels?.[level]
        ?? (dispatches ? dispatch?.thinkingLabel : undefined)
        ?? level,
    } : {}),
  };
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
  // The upsert REPLACES the row's state, so every field the projection reports must ride every update:
  // the delegated plugin knows only what it resolved at dispatch time (a continuation row carries neither
  // model nor level), and the live/scope read here is what keeps the rail, the drill-in and a reconnect
  // telling the same story as the child that is actually running. The identity read is authoritative when
  // it exists — including a level-less live child, whose dispatch-time level must NOT resurrect.
  const identity = sink.identityOf?.(update.sessionId, update);
  const model = update.model ?? identity?.model;
  const thinkingLevel = identity === undefined ? update.thinkingLevel : identity.thinkingLevel;
  const thinkingLabel = identity === undefined
    ? update.thinkingLabel
    : identity.thinkingLabel ?? identity.thinkingLevel;
  const enriched: SubagentUpdate = {
    ...update,
    // Assigned (possibly UNDEFINED) rather than conditionally spread: the update's own dispatch-time
    // level must not survive the base spread when the identity read says the child runs on none.
    model,
    thinkingLevel,
    thinkingLabel,
  };
  if (!store.upsertSubagentRun(sessionId, enriched, enriched.status)) return false;
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
