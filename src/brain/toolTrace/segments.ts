/**
 * Hydration half of the module: {@link ToolTrace} records → the `BrainSegment`s a client already knows
 * how to draw. No renderer changes anywhere, because a recorded call becomes exactly the segment a
 * direct call produces in `shapeBrainMessages`.
 *
 * The row id is READ from the record, never recomputed here — see the id invariant in `types.ts`.
 *
 * Imports nothing from the view layer (the records arrive already display-shaped from `record.ts`), so
 * `messageView` can import this file without a cycle.
 */
import type { BrainSegment, ToolOutputView } from '../../shared/wireContract.js';
import type { ToolTrace } from './types.js';

/** The rows in one reported payload, in order. Empty when the payload recorded no call — the reporting
 *  call then keeps its own row, because a turn that renders nothing is worse than a wrapper row. */
export function segmentsForTraces(traces: readonly ToolTrace[]): BrainSegment[] {
  const segments: BrainSegment[] = [];
  for (const trace of traces) {
    if (trace.kind !== 'call') continue;
    segments.push({
      kind: 'tool',
      name: trace.name,
      ...(trace.row ? { id: trace.row } : {}),
      ...(trace.detail ? { detail: trace.detail } : {}),
      ...(trace.diff ? { diff: trace.diff } : {}),
      ...(trace.output ? { output: trace.output } : {}),
      ...(trace.command ? { command: trace.command } : {}),
    });
  }
  const notes = traceNotes(traces);
  const first = segments[0];
  // A note has no row of its own: inventing one would put the wrapper row back under a new name. It
  // rides the first row's output instead — the same place a `tools.call.after` hook's note lands.
  if (notes.length > 0 && first && first.kind === 'tool') segments[0] = { ...first, output: withNotes(first.output, notes) };
  return segments;
}

/** The progress lines in a payload, for a caller that keeps its own row (no call was recorded) and has
 *  to carry them there. */
export function traceNotes(traces: readonly ToolTrace[]): string[] {
  return traces.filter((trace): trace is Extract<ToolTrace, { kind: 'note' }> => trace.kind === 'note').map((trace) => trace.text);
}

/** Append notes to an output view, minting the minimal notes-only view when the row had no output —
 *  the same shape `toolOutputView` returns for an annotated diff result. */
export function withNotes(output: ToolOutputView | undefined, notes: readonly string[]): ToolOutputView {
  if (notes.length === 0) return output ?? { title: 'tool result', kind: 'result', text: '', tone: 'normal' };
  const merged = [...(output?.notes ?? []), ...notes];
  return output
    ? { ...output, notes: merged }
    : { title: 'tool result', kind: 'result', text: '', tone: 'normal', notes: merged };
}
