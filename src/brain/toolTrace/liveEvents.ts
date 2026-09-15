/**
 * Live half of the module: the `BrainEvent`s a recorded call would have produced had the provider
 * called the tool itself. Two phases on purpose, mirroring a direct call:
 *
 * - {@link openEventsForCall} when the call STARTS, so a long nested run shows an in-progress row
 *   instead of nothing until it settles;
 * - {@link settleEventsForTrace} when it finishes, from the record that was actually accepted by the
 *   budget, so the streamed row and the reloaded row carry the same fields.
 *
 * The `icon` is deliberately NOT stamped here: the publishing seam stamps it with the same `iconOf` the
 * reducer uses for direct calls, so one map decides every glyph.
 */
import type { BrainEvent } from '../events.js';
import { toolCommand, toolDisplay } from '../messageView.js';
import type { ToolTrace } from './types.js';

/** The starting row for a nested call. `id` comes from {@link import('./types.js').traceRowId}. */
export function openEventsForCall(name: string, args: unknown, id: string | undefined): BrainEvent[] {
  const display = toolDisplay(name, args);
  const command = toolCommand(args);
  return [{
    type: 'tool',
    name: display.name,
    ...(display.detail ? { detail: display.detail } : {}),
    ...(command ? { command } : {}),
    ...(id ? { id } : {}),
  }];
}

/** The settle events for one accepted record: a diff, an output block, or a bare completion — the same
 *  three-way choice `toBrainEvent` makes for a real `tool_execution_end`. */
export function settleEventsForTrace(trace: ToolTrace, id: string | undefined): BrainEvent[] {
  if (trace.kind === 'note') return id ? [{ type: 'tool_progress', id, text: trace.text }] : [];
  if (trace.diff) return [{ type: 'diff', diff: trace.diff, ...(id ? { id } : {}), ...(trace.output ? { output: trace.output } : {}) }];
  if (trace.output) return [{ type: 'tool_output', output: trace.output, ...(id ? { id } : {}) }];
  return [{ type: 'tool_end', ...(id ? { id } : {}), ...(trace.isError ? { isError: true } : {}) }];
}
