// The BrainEvent contract is imported TYPE-ONLY straight from the daemon source, so a renamed or
// reshaped event breaks this fake daemon's typecheck (the whole point: the harness must exercise the
// SAME wire union the real daemon emits, never a hand-copied drift). The import erases at runtime.
import type { BrainEvent } from '../../../../src/brain/events.ts';

export type { BrainEvent };

/** The exact `idle` variant of the union — its optional `usage`/`model` fields drive `/__test/idle`. */
export type IdleEvent = Extract<BrainEvent, { type: 'idle' }>;

/** Build the SSE frame fields for a BrainEvent. The event's `type` becomes the SSE `event:` name (the
 *  web attaches its listeners per type), and the whole event is the JSON `data:` payload — exactly the
 *  real daemon's non-replay frame shape (no `id`/replay cursor; the fake daemon does not coalesce). */
export function sseFrame(event: BrainEvent): { event: string; data: string } {
  return { event: event.type, data: JSON.stringify(event) };
}

/** Convenience constructor for the terminal idle frame the control channel's `/__test/idle` emits. */
export function idleEvent(opts: { usage?: IdleEvent['usage']; model?: string } = {}): BrainEvent {
  return { type: 'idle', ...(opts.usage ? { usage: opts.usage } : {}), ...(opts.model ? { model: opts.model } : {}) };
}
