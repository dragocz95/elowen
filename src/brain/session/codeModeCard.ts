import { currentCardEmitter } from '../../plugins/policyContext.js';

/** How many rows the panel keeps. A script can call tools in a loop, and the panel is a live view of what
 *  is happening now, not an audit log — the transcript keeps the durable record. Well under the card
 *  registry's own 50-item cap so the tail is never silently clipped by the coercion step. */
const MAX_ROWS = 20;

/** One row of the panel: a nested call, or a line the script pushed with `notify()`. */
interface Row {
  /** Stable across trimming, unlike a position: a script may hold dozens of calls open at once through
   *  `Promise.all`, and dropping the oldest row must not make a live one settle somebody else. */
  id: number;
  text: string;
  status: 'in_progress' | 'completed';
}

/**
 * The live panel for a code-mode session.
 *
 * A tool called from inside a script produces NO PI tool event, so none of the usual `tool` /
 * `tool_output` / `tool_end` stream reaches the UI and the user would watch a single silent `exec` run for
 * a minute with nothing to see. There is no host API that synthesises those events for a call the model
 * did not make, so the supported surface is a display card: one panel per session, re-emitted in place
 * under a stable id.
 *
 * The emitter is resolved per call rather than captured, because it is turn-bound in AsyncLocalStorage.
 * That also makes this safe for a cell that outlives its turn: such a cell still runs inside the async
 * scope of the turn that created it, so its rows land on that conversation, and a context without an
 * emitter simply drops them instead of throwing inside a tool call.
 */
export class CodeModeCardFeed {
  private readonly cardId: string;
  private readonly rows: Row[] = [];
  private nextRowId = 0;

  constructor(sessionId: string) {
    this.cardId = `code-mode-${sessionId}`;
  }

  /** Opens a row for a nested call and returns its id, to be settled when the call returns. */
  callStarted(toolName: string): number {
    this.nextRowId += 1;
    const id = this.nextRowId;
    this.push({ id, text: toolName, status: 'in_progress' });
    return id;
  }

  /** Closes a row. A failure is written into the text because a card row has no failed status. */
  callSettled(rowId: number, failure?: string): void {
    const entry = this.rows.find((row) => row.id === rowId);
    if (entry === undefined) return;
    entry.status = 'completed';
    if (failure !== undefined) entry.text = `${entry.text} — ${failure}`;
    this.emit();
  }

  /** A line the script pushed with `notify()`; it has no lifecycle of its own. */
  note(text: string): void {
    this.nextRowId += 1;
    this.push({ id: this.nextRowId, text, status: 'completed' });
  }

  private push(row: Row): void {
    this.rows.push(row);
    if (this.rows.length > MAX_ROWS) this.rows.shift();
    this.emit();
  }

  private emit(): void {
    currentCardEmitter()?.({
      id: this.cardId,
      title: 'exec',
      items: this.rows.map((row) => ({ text: row.text, status: row.status })),
    });
  }

  /** Clears the panel. A card with neither items nor body is the registry's REMOVE signal. */
  clear(): void {
    this.rows.length = 0;
    currentCardEmitter()?.({ id: this.cardId });
  }
}
