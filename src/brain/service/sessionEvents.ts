import type { BrainStore, SessionEventKind } from '../../store/brainStore.js';
import type { BrainEvent, SubagentUpdate, WorkflowUpdate } from '../events.js';
import type { LiveBrain } from '../session/liveBrain.js';

/** The session-event kinds that are display-only: a sub-agent's or a workflow's terminal marker. Unlike
 *  the owner-driven kinds they carry NO model-facing notice (the model receives the child's actual result
 *  separately via `subagent-result`/`workflow-result`), so they never go through recordSessionEvent —
 *  only recordDisplayMarker. */
type DisplayOnlyKind = 'subagent' | 'workflow';
type NoticeKind = Exclude<SessionEventKind, DisplayOnlyKind>;
type SessionEventFrame = Extract<BrainEvent, { type: 'session-event' }>;

/** The model-facing wording for each change — a predicate completing "the user …". Kept terse; the
 *  turn-context builder wraps the collected notices in one <system-reminder>. */
const NOTICE: Record<NoticeKind, (detail: string) => string> = {
  model: (d) => `switched your model to ${d}`,
  mode: (d) => `switched the work mode to ${d}`,
  rename: (d) => `renamed this conversation to "${d}"`,
  reasoning: (d) => `set your reasoning effort to ${d}`,
  cwd: (d) => `changed the working directory to ${d}`,
};

/** Record an owner-driven session-state change, in three parts:
 *   1. persist a display-only marker (brain_session_events) — the visible, reconnect-safe transcript line;
 *   2. publish a `session-event` on the live stream so connected clients render it immediately;
 *   3. queue a one-shot, model-facing notice so the agent is told on its NEXT turn (drained + cleared by
 *      the turn-context builder, never persisted — mirrors the mode reminder).
 *  The marker never enters brain_messages, so it stays out of the model's context and compaction.
 *
 *  `live` is optional: a conversation can be renamed from the picker while it is not running, in which
 *  case only the marker is persisted (there is no stream to publish on, and no agent waiting to be told —
 *  it simply shows the next time the transcript loads). Every caller goes through here so the
 *  empty-conversation guard cannot be bypassed by writing to the store directly. */
export function recordSessionEvent(
  store: BrainStore,
  sessionId: string,
  live: LiveBrain | undefined,
  kind: NoticeKind,
  detail: string,
): void {
  const clean = detail.trim();
  if (!clean) return;
  // Nothing to annotate before the conversation has any turns: the agent reads its model/mode/reasoning
  // from the very prompt it is about to be handed, so a marker stacked above the first message would
  // report a "change" to settings nobody has worked under yet. Setup before speaking is not history.
  if (!store.lastMessageAt(sessionId)) return;
  const event = store.appendSessionEvent(sessionId, kind, clean);
  if (!live) return;
  live.replay.publish({ type: 'session-event', id: event.id, kind: event.kind, detail: event.detail, at: event.at });
  (live.pendingSessionNotices ??= []).push(NOTICE[kind](clean));
}

/** Persist + publish a DISPLAY-ONLY session marker — the two visible parts of recordSessionEvent without
 *  the third (the model-facing notice). `publish` is passed rather than a LiveBrain because a display
 *  marker has no live-only side effect to guard: it is safe with or without a connected client (the row is
 *  what a reconnect reads). The empty-conversation guard is kept so a marker never stacks above the first
 *  message. */
function recordDisplayMarker(
  store: BrainStore,
  sessionId: string,
  publish: (event: SessionEventFrame) => void,
  kind: DisplayOnlyKind,
  detail: string,
): void {
  const clean = detail.trim();
  if (!clean) return;
  if (!store.lastMessageAt(sessionId)) return;
  const event = store.appendSessionEvent(sessionId, kind, clean);
  publish({ type: 'session-event', id: event.id, kind: event.kind, detail: event.detail, at: event.at });
}

/** Longest task line carried in a sub-agent marker's detail. The full task lives on the durable
 *  brain_subagent_runs row; the marker only needs enough to recognise which delegation just finished. */
const SUBAGENT_MARKER_TASK_MAX = 80;

/** A DelegateContinue tool emits its own terminal progress row after a successful mid-turn steer. That row
 * describes the SHORT continuation call, not the child turn it steered into: while the actual delegated
 * call still holds its lifecycle claim, showing/persisting `done` makes the UI mark the child complete and
 * then "restart" on its next real progress event. Keep it visibly running until the call claim ends. */
export function visibleSubagentUpdate(update: SubagentUpdate, delegatedCallRunning: boolean): SubagentUpdate {
  return delegatedCallRunning && (update.status === 'done' || update.status === 'error')
    ? { ...update, status: 'running' }
    : update;
}

/** Longest title carried in a workflow marker's detail. The full title lives on the durable
 *  brain_workflows snapshot; the marker only needs enough to recognise which DAG just finished. */
const WORKFLOW_MARKER_TITLE_MAX = 80;

/** First non-empty line of a task, clipped — the human-readable half of a sub-agent marker's label. */
function shortSubagentTask(task: string): string {
  const firstLine = task.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  return firstLine.length > SUBAGENT_MARKER_TASK_MAX ? `${firstLine.slice(0, SUBAGENT_MARKER_TASK_MAX - 1)}…` : firstLine;
}

/** Drop a display-only marker into the timeline when a delegated sub-agent reaches a terminal state —
 *  but only on the running→terminal TRANSITION, so a repeated terminal update (upsertSubagentRun always
 *  re-writes the row and returns true) cannot stack a second marker. `prevStatus` is the child's status
 *  read from the store BEFORE the upsert that carries this update. The marker's detail is small JSON
 *  carrying the child session id (for a later DelegateContinue), a clipped task line, and the outcome. */
export function recordSubagentFinishMarker(
  store: BrainStore,
  sessionId: string,
  publish: (event: SessionEventFrame) => void,
  prevStatus: 'running' | 'done' | 'error' | undefined,
  update: SubagentUpdate,
): void {
  if (update.status !== 'done' && update.status !== 'error') return;
  if (prevStatus === 'done' || prevStatus === 'error') return;
  const detail = JSON.stringify({ session: update.sessionId, task: shortSubagentTask(update.task), status: update.status });
  recordDisplayMarker(store, sessionId, publish, 'subagent', detail);
}

/** Drop a display-only marker into the timeline when a WORKFLOW reaches a terminal status — the whole-DAG
 *  twin of recordSubagentFinishMarker, and the timeline's only word on a finished DAG: the live `workflow`
 *  snapshots attach to the WorkflowStart tool row, which is not a flat announcement. Fires only on the
 *  running→terminal TRANSITION of the workflow's OWN status (a terminal snapshot can re-emit once a node's
 *  late event settles), so one workflow leaves exactly one marker. `prevStatus` is the workflow's status
 *  read from the store BEFORE the upsert that carries this snapshot. The marker's detail is small JSON
 *  carrying the workflow id (for a later WorkflowResume), the model-authored title, the outcome and how
 *  many of the nodes reached a terminal state. */
export function recordWorkflowFinishMarker(
  store: BrainStore,
  sessionId: string,
  publish: (event: SessionEventFrame) => void,
  prevStatus: 'running' | 'done' | 'error' | 'cancelled' | undefined,
  update: WorkflowUpdate,
): void {
  if (update.status !== 'done' && update.status !== 'error' && update.status !== 'cancelled') return;
  if (prevStatus === 'done' || prevStatus === 'error' || prevStatus === 'cancelled') return;
  const total = update.nodes.length;
  let ran = 0;
  for (const node of update.nodes) if (node.status === 'done' || node.status === 'error') ran += 1;
  const title = update.title?.trim();
  const detail = JSON.stringify({
    id: update.id,
    ...(title ? { title: title.length > WORKFLOW_MARKER_TITLE_MAX ? `${title.slice(0, WORKFLOW_MARKER_TITLE_MAX - 1)}…` : title } : {}),
    status: update.status,
    ran, total,
  });
  recordDisplayMarker(store, sessionId, publish, 'workflow', detail);
}

/** How long the reasoning level must sit unchanged before its marker lands. Cycling with ctrl+r fires
 *  one change per keypress and stepping several levels takes roughly 150–300ms between presses, so the
 *  window must comfortably outlast the next press of a burst; much longer only delays the marker after
 *  the user has visibly settled. */
export const REASONING_MARKER_DEBOUNCE_MS = 600;

/** Debounce the reasoning-effort marker: apply-now, announce-later. The caller has already applied the
 *  new level to the live session — only the visible marker (and its model-facing notice, both via
 *  recordSessionEvent) waits until the level has been STABLE for the debounce window, so cycling
 *  low→medium→high emits one "reasoning → high" instead of a marker per keystroke. Changing again
 *  restarts the window and keeps the latest target; settling back on the level the transcript last
 *  reflected cancels the marker entirely (nothing changed, nothing to announce). */
export function scheduleReasoningMarker(store: BrainStore, live: LiveBrain, previousLevel: string | undefined, level: string): void {
  const pending = live.pendingReasoningMarker;
  if (pending) clearTimeout(pending.timer);
  const baseline = pending ? pending.baseline : previousLevel;
  if (baseline === level) { live.pendingReasoningMarker = undefined; return; }
  const timer = setTimeout(() => flushReasoningMarker(store, live), REASONING_MARKER_DEBOUNCE_MS);
  timer.unref?.();
  live.pendingReasoningMarker = { timer, baseline, level };
}

/** Land a pending (debounced) reasoning marker NOW. Called by the settle timer, and by the turn runner
 *  at turn admission — a turn must not start with the marker still in flight, or the marker row would
 *  land AFTER the user message it preceded and its model-facing notice would miss the turn. No-op when
 *  nothing is pending. */
export function flushReasoningMarker(store: BrainStore, live: LiveBrain): void {
  const pending = live.pendingReasoningMarker;
  if (!pending) return;
  clearTimeout(pending.timer);
  live.pendingReasoningMarker = undefined;
  recordSessionEvent(store, live.sessionId, live, 'reasoning', live.thinkingLabels[pending.level] ?? pending.level);
}

/** Prepare the queued session-change notices into a single model-facing <system-reminder>, WITHOUT
 *  clearing the buffer yet — the same prepare/commit contract as `drainPostCompactionContext`. Returns
 *  `{ block: '', commit: noop }` when nothing is queued. Placed under the user message like the mode
 *  reminder — it is volatile per-turn context the agent should adapt to, not durable history.
 *
 *  Clearing the buffer here (as the previous one-shot version did) looked equivalent to clearing it once
 *  the prompt was actually handed to the provider, and it was not: the scheduling directory, template
 *  rendering, the client-generation check or the prompt call itself can still fail AFTER the buffer is
 *  emptied, leaving the visible marker in the transcript while the model is never told about the change.
 *  `commit` removes only the prefix captured HERE, so a notice queued concurrently — while this turn's
 *  prompt is still being assembled or in flight — survives and is delivered on a later turn instead of
 *  being silently dropped by a blind clear. */
/** Volatile `/cd`-style reorientation for a Sandbox-selected workspace. PI's static system prompt still
 * advertises the cwd it spawned with, so a turn whose effective directory differs must explicitly supersede
 * it. This block is never persisted and needs no commit: it is recomputed from live workspace selection on
 * every turn, which is what lets two writers alternate inside one room without rewriting its transcript. */
export function workDirReorientation(advertised: string | undefined, effective: string | undefined): string {
  if (!effective || effective === advertised) return '';
  return '<system-reminder>\n<current-workspace>\n'
    + `The effective working directory for this turn is ${effective}.\n`
    + '</current-workspace>\n'
    + '<instruction>This supersedes the static working directory advertised when the session was created. '
    + 'Resolve relative paths and delegated work from this directory for this turn. Do not ask the user to '
    + 'confirm the change.</instruction>\n</system-reminder>';
}

export function drainSessionNotices(live: LiveBrain): { block: string; commit: () => void } {
  const notices = live.pendingSessionNotices;
  if (!notices || notices.length === 0) return { block: '', commit: () => {} };
  const captured = notices.length;
  const rows = notices.slice(0, captured).map((n) => `- The user ${n}.`).join('\n');
  const block = '<system-reminder>\n<session-changes>\n'
    + `${rows}\n</session-changes>\n`
    + '<instruction>These settings changed since your last reply. Work under the new settings from now on '
    + '(e.g. a new work mode or model) and do not re-confirm them with the user.</instruction>\n'
    + '</system-reminder>';
  // Committed only once the prompt carrying this block has actually reached the provider (see the
  // caller). Removing just the captured prefix — not clearing the whole array — means a notice pushed by
  // a concurrent settings change in that window is not lost with it.
  const commit = (): void => {
    const current = live.pendingSessionNotices;
    if (!current) return;
    live.pendingSessionNotices = current.length > captured ? current.slice(captured) : [];
  };
  return { block, commit };
}
