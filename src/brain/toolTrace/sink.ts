/**
 * The producer-facing seam: wrap a call, get a row.
 *
 * This is the only file in the module that touches the live transport (the turn-bound emitter in
 * AsyncLocalStorage) and the icon map, which keeps `record.ts` and `segments.ts` pure and unit-testable.
 *
 * A producer wraps each call in {@link ToolTraceSink.call} and reports {@link ToolTraceSink.drain} on its
 * own tool result. Wrapping, rather than an open/settle pair at the call site, is deliberate: the two
 * halves cannot drift apart and a thrown error still closes its row.
 */
import { currentToolTraceEmitter } from '../../plugins/policyContext.js';
import type { BrainEvent } from '../events.js';
import { openEventsForCall, settleEventsForTrace } from './liveEvents.js';
import { ToolTraceLog, traceForCall } from './record.js';
import type { ToolTrace } from './types.js';

export interface ToolTraceSink {
  /** Run one nested call as a transcript row: opens the row, runs `execute`, settles the row with the
   *  result, and rethrows a failure after recording it as an errored row.
   *
   *  `execute` receives the ROW ID, and a caller that has a tool-call id to pass should pass this one:
   *  anything the tool itself keys on that id (delegated sub-agent progress, a workflow run, an inline
   *  artifact) then lands on this row instead of on an id no row carries. */
  call<T>(name: string, args: unknown, execute: (rowId: string | undefined) => Promise<T>): Promise<T>;
  /** A progress line for the user, keyed to its own row so the live event lands under the right row. */
  note(text: string): void;
  /** The records not yet reported, for the reporting tool result's `details.toolTrace`. */
  drain(): ToolTrace[];
}

/** A sink for one producer (a code-mode cell). `iconOf` resolves the same tool→icon map the reducer
 *  stamps on a direct call, so a recorded row carries the same glyph; without it a client falls back to
 *  its generic glyph. */
export function createToolTraceSink(producerId: string, iconOf?: (name: string) => string | undefined): ToolTraceSink {
  const log = new ToolTraceLog(producerId);
  // Resolved PER EVENT, never captured: a code-mode cell that yields outlives the turn that created it
  // but still runs inside that turn's async scope, and a scope without an emitter drops the event.
  const publish = (events: readonly BrainEvent[]): void => {
    const emit = currentToolTraceEmitter();
    if (emit === null) return;
    for (const event of events) emit(event.type === 'tool' && iconOf ? { ...event, icon: iconOf(event.name) } : event);
  };

  return {
    async call<T>(name: string, args: unknown, execute: (rowId: string | undefined) => Promise<T>): Promise<T> {
      const row = log.open(name);
      if (row !== undefined) publish(openEventsForCall(name, args, row));
      try {
        const result = await execute(row);
        if (row !== undefined) publish(settleEventsForTrace(log.settle(row, traceForCall(name, args, result)), row));
        return result;
      } catch (error) {
        // The failure text is what the producer's own caller will see, so it belongs on the row too.
        const message = error instanceof Error ? error.message : String(error);
        if (row !== undefined) {
          const failed = traceForCall(name, args, { content: [{ type: 'text', text: message }], isError: true }, true);
          publish(settleEventsForTrace(log.settle(row, failed), row));
        }
        throw error;
      }
    },
    note(text: string): void {
      const row = log.note(text);
      if (row !== undefined) publish(settleEventsForTrace({ kind: 'note', text }, row));
    },
    drain: () => log.drain(),
  };
}
