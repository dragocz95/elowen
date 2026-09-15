/**
 * Builds {@link ToolTrace} records with the SAME formatters a direct tool call renders through
 * (`toolDisplay`, `toolCommand`, `toolOutputView`, `details.diff` in `messageView.ts`). Nothing about
 * activity recorded here is formatted by a second code path — that is what keeps a nested row and a
 * direct row looking identical, and what makes the parity test in `tests/brain/toolTraceParity.test.ts`
 * meaningful rather than tautological.
 */
import { toolCommand, toolDisplay, toolOutputView } from '../messageView.js';
import { MAX_TRACE_BYTES, MAX_TRACE_RECORDS, type ToolTrace, type ToolTraceCall } from './types.js';

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
 * The per-call record log, which owns the budget.
 *
 * `push` returns the record that was actually ACCEPTED (possibly reduced to its name, or undefined when
 * the budget is exhausted), and a caller emits live events for exactly that return value. Emitting the
 * unreduced record instead is how the live stream and the reloaded transcript drift apart.
 */
export class ToolTraceLog {
  private readonly entries: ToolTrace[] = [];
  private bytes = 0;
  private dropped = 0;

  push(trace: ToolTrace): ToolTrace | undefined {
    if (this.entries.length >= MAX_TRACE_RECORDS) { this.dropped += 1; return undefined; }
    const accepted = this.fit(trace);
    if (accepted === undefined) { this.dropped += 1; return undefined; }
    this.entries.push(accepted);
    this.bytes += sizeOf(accepted);
    return accepted;
  }

  /** The records to persist: what was accepted, plus one visible note when anything was dropped. A
   *  silent truncation would read as "the script did less work than it did". */
  records(): ToolTrace[] {
    if (this.dropped === 0) return [...this.entries];
    return [...this.entries, { kind: 'note', text: `… ${this.dropped} further call(s) not recorded` }];
  }

  /** Whether any CALL was recorded. A caller uses this to decide whether its own row is redundant (the
   *  rows below it tell the story) or the only thing the user would see. */
  hasCalls(): boolean {
    return this.entries.some((entry) => entry.kind === 'call');
  }

  /** Fit a record into the byte budget: keep it whole when it fits, otherwise strip the heavy display
   *  fields and keep the identity (name + error), otherwise refuse it. */
  private fit(trace: ToolTrace): ToolTrace | undefined {
    if (this.bytes + sizeOf(trace) <= MAX_TRACE_BYTES) return trace;
    if (trace.kind !== 'call') return undefined;
    const minimal: ToolTraceCall = { kind: 'call', name: trace.name, ...(trace.isError ? { isError: true } : {}) };
    return this.bytes + sizeOf(minimal) <= MAX_TRACE_BYTES ? minimal : undefined;
  }
}

function sizeOf(trace: ToolTrace): number {
  return Buffer.byteLength(JSON.stringify(trace), 'utf8');
}
