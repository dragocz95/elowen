import type { BrainEvent } from '../events.js';
import type { BrainMessageView } from '../messageView.js';

/** A bounded snapshot of events emitted during the currently unsettled run. The durable transcript
 *  stays in SQLite; this journal only bridges the gap before PI's terminal `agent_end` persists the
 *  assistant/tool messages. */
export interface LiveEventSnapshot {
  cursor: number;
  events: BrainEvent[];
}

/** Extra transport metadata for a reconnect snapshot. The ordinary `snapshot()` API intentionally
 * stays minimal for internal callers; stream snapshots carry enough identity to reconcile a dropped
 * SSE without guessing from JSON-shaped events. */
export interface LiveEventTransportSnapshot extends LiveEventSnapshot {
  /** Monotonic run generation for this live PI session. `agent_start` advances it, including goal
   * continuations that have no user echo between turns. */
  run: number;
  /** Cursor for each replay entry at the matching index in `events`. Live SSE frames carry the same
   * cursor as their SSE `id`, so reconnect clients can recognize a coalesced/replaced entry exactly. */
  eventCursors: number[];
  /** The bounded journal discarded an unsettled entry. Durable history becomes authoritative at the
   * terminal boundary; clients must refresh it instead of presenting this partial tail as complete. */
  truncated?: true;
}

/** First frame on an opt-in snapshot SSE stream. `history` is the durable clean transcript; `events`
 *  is the current run's not-yet-durable tail. Replacing the client view from this frame makes repeated
 *  snapshot reconnects idempotent instead of appending duplicate deltas. */
export interface BrainStreamSnapshot extends LiveEventSnapshot {
  type: 'snapshot';
  history: BrainMessageView[];
  /** The actual tapped session. It can differ from the query after an idle rollover retargeted this
   * stable client while its previous SSE was down. */
  sessionId?: string;
  run?: number;
  eventCursors?: number[];
  truncated?: true;
}

const MAX_EVENTS = 512;
const MAX_CHARS = 512 * 1024;

type Entry = { seq: number; event: BrainEvent; chars: number };

/** A symbol keeps replay cursors available to the server/client transport without widening the public
 * BrainEvent JSON contract. Symbols are skipped by JSON.stringify, while SSE `id` / snapshot
 * `eventCursors` carry the value across the wire. */
const replayCursor = Symbol('brainReplayCursor');
type StampedBrainEvent = BrainEvent & { [replayCursor]?: number };

export function brainEventReplayCursor(event: BrainEvent): number | undefined {
  return (event as StampedBrainEvent)[replayCursor];
}

export function stampBrainEventReplayCursor(event: BrainEvent, cursor: number | undefined): BrainEvent {
  if (cursor === undefined) return event;
  const stamped = { ...event } as StampedBrainEvent;
  // Non-enumerable keeps ordinary deep equality/JSON output exactly on the public BrainEvent contract.
  Object.defineProperty(stamped, replayCursor, { value: cursor, enumerable: false });
  return stamped;
}

/** Return a JSON-safe event copy. A replay cursor is deliberately transport metadata, never a public
 * event property that plugins/Discord clients should observe. */
export function withoutBrainEventReplayCursor(event: BrainEvent): BrainEvent {
  return { ...event };
}

/** Mirror LiveEventReplay's event replacement rules in route-local buffers and headless reconcilers.
 * This is deliberately exported instead of duplicated: a snapshot replaces `tool_progress`, cards,
 * queue/process/step state and sub-agent progress in place, so a local journal must do exactly the same
 * before it can compare a reconnect tail. Returns true only when the bounded buffer dropped an entry. */
export function appendReplayBrainEvent(events: BrainEvent[], event: BrainEvent, maxEvents = Number.POSITIVE_INFINITY): boolean {
  const last = events.at(-1);
  if (last?.type === 'text' && event.type === 'text') {
    events[events.length - 1] = stampBrainEventReplayCursor(
      { type: 'text', delta: last.delta + event.delta }, brainEventReplayCursor(event),
    );
    return false;
  }
  if (last?.type === 'reasoning' && event.type === 'reasoning') {
    events[events.length - 1] = stampBrainEventReplayCursor(
      { type: 'reasoning', delta: last.delta + event.delta }, brainEventReplayCursor(event),
    );
    return false;
  }

  let replace = -1;
  if (event.type === 'tool_progress') {
    replace = events.findLastIndex((entry) => entry.type === 'tool_progress' && entry.id === event.id);
  } else if (event.type === 'subagent') {
    replace = events.findLastIndex((entry) => entry.type === 'subagent' && entry.id === event.id);
  } else if (event.type === 'card') {
    replace = events.findLastIndex((entry) => entry.type === 'card' && entry.card.id === event.card.id);
  } else if (event.type === 'notice') {
    replace = events.findLastIndex((entry) => entry.type === 'notice' && entry.kind === event.kind);
  } else if (event.type === 'queue' || event.type === 'step' || event.type === 'process' || event.type === 'goal') {
    replace = events.findLastIndex((entry) => entry.type === event.type);
  }
  if (replace >= 0) {
    events[replace] = event;
    return false;
  }
  events.push(event);
  if (events.length <= maxEvents) return false;
  events.shift();
  return true;
}

/** Append one event to a short-lived transport buffer, coalescing adjacent provider deltas without ever
 * mutating an event object owned by the replay fan-out. Multiple snapshot streams receive the SAME event
 * reference from LiveEventReplay.publish(); replacing the local tail is therefore essential — mutating it
 * would make each concurrent stream append the new delta again to every other stream's buffered copy. */
export function appendBufferedBrainEvent(events: BrainEvent[], event: BrainEvent, maxEvents: number): void {
  void appendReplayBrainEvent(events, event, maxEvents);
}

function eventChars(event: BrainEvent): number {
  try { return JSON.stringify(event).length; }
  catch { return 0; }
}

/** Current-run replay buffer plus the single fan-out seam for a LiveBrain. Adjacent text/reasoning
 *  deltas are coalesced and snapshot-style events are replaced in place, so a long streaming run does
 *  not retain one object per provider chunk. Both event count and serialized size are hard-bounded. */
export class LiveEventReplay {
  private seq = 0;
  private run = 0;
  private entries: Entry[] = [];
  private chars = 0;
  private truncated = false;

  constructor(private listeners: Set<(event: BrainEvent) => void>) {}

  /** A new PI run starts from the already-durable history, so only this run needs replaying. */
  beginRun(): void { this.run++; this.clear(); }

  /** `agent_end` is observed after the factory subscription persisted the completed run. Drop its
   *  transient deltas before publishing the terminal idle/error events, preventing snapshot/history
   *  duplication at the settle boundary. */
  settleRun(): void { this.clear(); }

  publish(event: BrainEvent): void {
    const stamped = this.record(event);
    for (const listener of this.listeners) listener(stamped);
  }

  /** Add an ordering marker without broadcasting it to the platform that already rendered the sender's
   * own message (shared Discord/WhatsApp channel steer). Snapshot clients still need the marker. */
  journal(event: BrainEvent): void { this.record(event); }

  snapshot(): LiveEventSnapshot {
    return { cursor: this.seq, events: this.entries.map((entry) => withoutBrainEventReplayCursor(entry.event)) };
  }

  /** Snapshot variant for `/brain/stream?snapshot=1`. The parallel cursor array keeps the public event
   * payload unchanged while allowing a reconnecting CLI to distinguish an already printed token/state
   * replacement from a genuinely new one. */
  transportSnapshot(): LiveEventTransportSnapshot {
    return {
      ...this.snapshot(),
      run: this.run,
      eventCursors: this.entries.map((entry) => entry.seq),
      ...(this.truncated ? { truncated: true as const } : {}),
    };
  }

  private clear(): void {
    this.entries = [];
    this.chars = 0;
    this.truncated = false;
  }

  private replaceAt(index: number, event: BrainEvent, seq: number): void {
    const prior = this.entries[index]!;
    const chars = eventChars(event);
    this.chars += chars - prior.chars;
    this.entries[index] = { seq, event, chars };
  }

  private record(event: BrainEvent): BrainEvent {
    const seq = ++this.seq;
    const stamped = stampBrainEventReplayCursor(event, seq);
    // A durable user event is an ORDERING marker. streamSnapshot removes its matching SQLite row from
    // the history half and replays this marker between the surrounding live deltas. Without it a mid-run
    // steer would jump ahead of already-streamed assistant/tool output on reconnect.
    const last = this.entries.at(-1);
    // Provider deltas are often a few characters each. One replay event per visible stream keeps the
    // snapshot compact while preserving the exact text the reducer would have received.
    if (last && stamped.type === 'text' && last.event.type === 'text') {
      this.replaceAt(this.entries.length - 1, stampBrainEventReplayCursor({ type: 'text', delta: last.event.delta + stamped.delta }, seq), seq);
      this.trim();
      return stamped;
    }
    if (last && stamped.type === 'reasoning' && last.event.type === 'reasoning') {
      this.replaceAt(this.entries.length - 1, stampBrainEventReplayCursor({ type: 'reasoning', delta: last.event.delta + stamped.delta }, seq), seq);
      this.trim();
      return stamped;
    }

    // These events are complete snapshots/current state. Keeping only their newest instance loses no
    // transcript information and prevents progress/status churn from dominating the replay budget.
    let replace = -1;
    if (stamped.type === 'tool_progress') {
      replace = this.entries.findLastIndex((entry) => entry.event.type === 'tool_progress' && entry.event.id === stamped.id);
    } else if (stamped.type === 'subagent') {
      // A sub-agent update is a complete snapshot keyed by the parent's delegate tool call. Keep only
      // the newest one: durable history carries the same latest state, and progress churn must not crowd
      // the actual parent stream out of the bounded reconnect journal.
      replace = this.entries.findLastIndex((entry) => entry.event.type === 'subagent' && entry.event.id === stamped.id);
    } else if (stamped.type === 'card') {
      replace = this.entries.findLastIndex((entry) => entry.event.type === 'card' && entry.event.card.id === stamped.card.id);
    } else if (stamped.type === 'notice') {
      replace = this.entries.findLastIndex((entry) => entry.event.type === 'notice' && entry.event.kind === stamped.kind);
    } else if (stamped.type === 'queue' || stamped.type === 'step' || stamped.type === 'process' || stamped.type === 'goal') {
      replace = this.entries.findLastIndex((entry) => entry.event.type === stamped.type);
    }
    if (replace >= 0) this.replaceAt(replace, stamped, seq);
    else {
      const chars = eventChars(stamped);
      this.entries.push({ seq, event: stamped, chars });
      this.chars += chars;
    }
    this.trim();
    return stamped;
  }

  private trim(): void {
    while (this.entries.length > MAX_EVENTS || this.chars > MAX_CHARS) {
      const dropped = this.entries.shift();
      if (!dropped) break;
      this.chars -= dropped.chars;
      this.truncated = true;
    }
  }
}
