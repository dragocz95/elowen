/**
 * Builds {@link ToolTrace} records with the SAME formatters a direct tool call renders through
 * (`toolDisplay`, `toolCommand`, `toolOutputView`, `details.diff` in `messageView.ts`). Nothing about
 * activity recorded here is formatted by a second code path — that is what keeps a nested row and a
 * direct row looking identical, and what makes the parity test in `tests/brain/toolTraceParity.test.ts`
 * meaningful rather than tautological.
 */
import { toolCommand, toolDisplay, toolOutputView } from '../messageView.js';
import { MAX_TRACE_BYTES, MAX_TRACE_RECORDS, traceRowId, type ToolTrace, type ToolTraceCall } from './types.js';

/** Build the record for one settled call. `isError` is the caller's own verdict (a refusal, a thrown
 *  error) and is authoritative, exactly as the `isError` flag on a PI tool event is. */
export function traceForCall(name: string, args: unknown, result: unknown, isError?: boolean): ToolTraceCall {
  const display = toolDisplay(name, args);
  const diff = (result as { details?: { diff?: unknown } } | null | undefined)?.details?.diff;
  const output = toolOutputView(name, args, result, isError);
  const command = toolCommand(args);
  return {
    kind: 'call',
    name: display.name,
    ...(display.detail ? { detail: display.detail } : {}),
    ...(command ? { command } : {}),
    ...(typeof diff === 'string' && diff.trim() ? { diff } : {}),
    ...(output ? { output } : {}),
    ...(isError === true ? { isError: true } : {}),
  };
}

/**
 * The per-producer record log: it mints row ids, owns the budget, and hands each record out exactly once.
 *
 * ONE LOG PER PRODUCER, not per reporting call. A code-mode cell keeps working after `exec` has yielded,
 * so its rows are reported across several tool calls (`exec`, then each `wait`); ids therefore belong to
 * the cell and {@link drain} returns only what has not been reported yet. Reporting a record twice would
 * draw its row twice.
 *
 * A call is registered when it STARTS, because that is when its live row is drawn and its id must exist.
 * The slot is filled with the minimal record immediately, so an id that was handed out always has a
 * durable twin: the budget can shrink a record, never make a streamed row vanish on reload. A call
 * refused at open time gets no id and no live row, and is counted into the truncation note instead.
 */
export class ToolTraceLog {
  private readonly entries: ToolTrace[] = [];
  private readonly rows = new Map<string, number>();
  private bytes = 0;
  private dropped = 0;
  private reported = 0;
  private droppedReported = 0;

  constructor(private readonly producerId: string) {}

  /** Register a starting call. Returns its row id, or undefined when the log is full — a caller that
   *  gets undefined must not emit a live row for that call. */
  open(name: string): string | undefined {
    const minimal: ToolTraceCall = { kind: 'call', name };
    const row = this.append(minimal);
    if (row === undefined) return undefined;
    this.entries[this.rows.get(row)!] = { ...minimal, row };
    return row;
  }

  /** Fill in a settled call, upgrading its slot to the full display record when the byte budget allows.
   *  Returns the record now STORED, which is exactly what the caller may emit as its settle event. */
  settle(row: string, trace: ToolTraceCall): ToolTraceCall {
    const index = this.rows.get(row);
    const current = index === undefined ? undefined : this.entries[index];
    if (index === undefined || current === undefined || current.kind !== 'call') return trace;
    const full: ToolTraceCall = { ...trace, row };
    const minimal: ToolTraceCall = { kind: 'call', row, name: trace.name, ...(trace.isError ? { isError: true } : {}) };
    const budget = this.bytes - sizeOf(current);
    const stored = budget + sizeOf(full) <= MAX_TRACE_BYTES ? full : minimal;
    this.entries[index] = stored;
    this.bytes = budget + sizeOf(stored);
    return stored;
  }

  /** Append a progress line. Returns the row id it is keyed to for live progress (notes occupy an index
   *  of their own so nothing shifts), or undefined when the log is full. */
  note(text: string): string | undefined {
    return this.append({ kind: 'note', text });
  }

  /** The records not yet reported, plus one visible note when anything was refused since the last drain.
   *  A silent truncation would read as "the script did less work than it did". */
  drain(): ToolTrace[] {
    const fresh = this.entries.slice(this.reported);
    this.reported = this.entries.length;
    const newlyDropped = this.dropped - this.droppedReported;
    this.droppedReported = this.dropped;
    if (newlyDropped === 0) return fresh;
    return [...fresh, { kind: 'note', text: `… ${newlyDropped} further call(s) not recorded` }];
  }

  /** Whether this producer has recorded any CALL at all. A caller uses it to decide whether its own row
   *  is redundant (the rows below it tell the story) or the only thing the user would see. */
  hasCalls(): boolean {
    return this.entries.some((entry) => entry.kind === 'call');
  }

  private append(trace: ToolTrace): string | undefined {
    if (this.entries.length >= MAX_TRACE_RECORDS) { this.dropped += 1; return undefined; }
    if (this.bytes + sizeOf(trace) > MAX_TRACE_BYTES) { this.dropped += 1; return undefined; }
    const row = traceRowId(this.producerId, this.entries.length);
    this.rows.set(row, this.entries.length);
    this.entries.push(trace);
    this.bytes += sizeOf(trace);
    return row;
  }
}

function sizeOf(trace: ToolTrace): number {
  return Buffer.byteLength(JSON.stringify(trace), 'utf8');
}
