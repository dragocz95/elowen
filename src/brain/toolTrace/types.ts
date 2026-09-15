/**
 * The durable record of TOOL ACTIVITY THE PROVIDER NEVER SAW.
 *
 * A tool the model called itself arrives as a PI tool event and every surface already renders it. Work
 * the agent performed WITHOUT such an event produces none, so without this module it leaves the user
 * watching a single opaque row. Today the one producer is a code-mode script calling `tools.*`; the
 * module is shaped for the class rather than for that caller, and a second one reaches it the same way
 * code mode does — through a sink core hands to the control it owns.
 *
 * This file is the contract only: the record shape, the budget and the id rule. It imports nothing from
 * the view layer on purpose, so the record can be read by `messageView` (hydration) while the builder in
 * `record.ts` reads `messageView`'s formatters, without a cycle.
 *
 * THREE INVARIANTS A NEW CALLER MUST HONOUR:
 *
 * 1. A ROW ID IS MINTED ONCE, by the producer, and travels INSIDE the record — see {@link traceRowId}.
 *    The live event and the stored record therefore carry the same id by construction, instead of two
 *    sides recomputing it and drifting; a drift draws the row twice, once from the stream and once from
 *    the refetch, rather than patching it.
 *    A positional id would not survive the real producer: a code-mode cell keeps recording after `exec`
 *    has yielded, so the rows of one cell are reported across several tool calls, and the position of a
 *    record inside one call's payload says nothing about which row it is.
 * 2. EVERY LIVE ROW NEEDS A DURABLE TWIN, and each record must be reported exactly ONCE. A live-only row
 *    works until the user presses F5 and then vanishes; a record reported by two calls draws twice.
 * 3. THE PAYLOAD IS CAPPED, visibly — {@link MAX_TRACE_RECORDS}, {@link MAX_TRACE_BYTES}. A loop calling
 *    a tool a thousand times must not grow the stored row without bound, and truncation must be stated
 *    rather than silent.
 */
import type { ToolOutputView } from '../../shared/wireContract.js';

/** One nested call, already display-shaped by {@link import('./record.js').traceForCall}.
 *
 *  The DERIVED VIEW is stored, not the raw result: the model already read the raw result inside the
 *  owning call's own output, so persisting it again would double the weight of every rehydrate (a `Read`
 *  of a large file being the obvious case). Consequence to accept: the output caps are frozen at call
 *  time here, where a direct call re-derives them at render. */
export interface ToolTraceCall {
  kind: 'call';
  /** The row this record is, minted by the producer. `traceForCall` builds the record without it and
   *  `ToolTraceLog.settle` stamps the id the call was opened with, so it is absent only before that. */
  row?: string;
  name: string;
  detail?: string;
  command?: string;
  diff?: string;
  output?: ToolOutputView;
  isError?: boolean;
}

/** A progress line the activity emitted for the USER (a code-mode script's `notify()`). It has no
 *  lifecycle of its own, so it never becomes a row: it renders inside the owning row's output. */
export interface ToolTraceNote {
  kind: 'note';
  text: string;
}

export type ToolTrace = ToolTraceCall | ToolTraceNote;

/** Records kept per producer (per code-mode cell). A panel is a live view of what is happening, not an
 *  audit log; the transcript keeps the durable record and the stored rows have to stay a sane size. */
export const MAX_TRACE_RECORDS = 100;

/** Serialised budget per producer. Reached before the count when results carry large diffs. */
export const MAX_TRACE_BYTES = 128 * 1024;

/** The id of the nth row of `producerId`. Called in exactly one place — the sink that mints the row —
 *  and never recomputed by a reader. */
export function traceRowId(producerId: string, index: number): string {
  return `${producerId}:${index}`;
}

/** Read a persisted trace payload back defensively. The stored row is untrusted input by the time it is
 *  read again (an older daemon wrote it, a plugin supplied it), so anything that is not a well-formed
 *  record is dropped instead of reaching a renderer. */
export function parseToolTraces(value: unknown): ToolTrace[] {
  if (!Array.isArray(value)) return [];
  const out: ToolTrace[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Partial<ToolTraceCall> & Partial<ToolTraceNote>;
    if (record.kind === 'call' && typeof record.name === 'string' && record.name) {
      out.push({
        kind: 'call',
        ...(typeof record.row === 'string' && record.row ? { row: record.row } : {}),
        name: record.name,
        ...(typeof record.detail === 'string' ? { detail: record.detail } : {}),
        ...(typeof record.command === 'string' ? { command: record.command } : {}),
        ...(typeof record.diff === 'string' ? { diff: record.diff } : {}),
        ...(record.output && typeof record.output === 'object' ? { output: record.output } : {}),
        ...(record.isError === true ? { isError: true } : {}),
      });
      continue;
    }
    if (record.kind === 'note' && typeof record.text === 'string' && record.text) out.push({ kind: 'note', text: record.text });
  }
  return out;
}
