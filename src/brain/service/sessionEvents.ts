import type { BrainStore, SessionEventKind } from '../../store/brainStore.js';
import type { LiveBrain } from '../session/liveBrain.js';

/** The model-facing wording for each change — a predicate completing "the user …". Kept terse; the
 *  turn-context builder wraps the collected notices in one <system-reminder>. */
const NOTICE: Record<SessionEventKind, (detail: string) => string> = {
  model: (d) => `switched your model to ${d}`,
  mode: (d) => `switched the work mode to ${d}`,
  rename: (d) => `renamed this conversation to "${d}"`,
  reasoning: (d) => `set your reasoning effort to ${d}`,
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
  kind: SessionEventKind,
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

/** Drain the queued session-change notices into a single model-facing <system-reminder>, clearing the
 *  buffer (one-shot). Returns '' when nothing is queued. Placed under the user message like the mode
 *  reminder — it is volatile per-turn context the agent should adapt to, not durable history. */
export function drainSessionNotices(live: LiveBrain): string {
  const notices = live.pendingSessionNotices;
  if (!notices || notices.length === 0) return '';
  live.pendingSessionNotices = [];
  const rows = notices.map((n) => `- The user ${n}.`).join('\n');
  return '<system-reminder>\n<session-changes>\n'
    + `${rows}\n</session-changes>\n`
    + '<instruction>These settings changed since your last reply. Work under the new settings from now on '
    + '(e.g. a new work mode or model) and do not re-confirm them with the user.</instruction>\n'
    + '</system-reminder>';
}
