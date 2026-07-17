import { randomUUID } from 'node:crypto';
import type { AskAnswer, AskQuestion, BrainEvent } from './events.js';

/** Default time a parked question waits before it auto-resolves so the turn never hangs forever. */
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** What a timed-out question resolves to — a clear, model-readable sentinel per question (English: this
 *  is core code in the public package and the text is fed to the model, which localizes its own reply). */
const NO_ANSWER: AskAnswer['selected'] = ['[no answer within the time limit]'];

interface Pending {
  sessionId: string;
  questions: AskQuestion[];
  /** Distinct flavour of the parked question: 'approval' = a blocking tool-permission prompt (three
   *  fixed options), absent = a regular AskUserQuestion. Rides the emitted `ask` event so every
   *  frontend can style approvals differently while reusing the whole answer pipeline. */
  kind?: 'approval';
  resolve: (answers: AskAnswer[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** In-memory registry of parked `AskUserQuestion` calls. One instance is owned by BrainService and
 *  serves every surface (web/CLI via `/brain/answer`, Discord in-process): a tool's `execute` awaits
 *  `ask()`, which emits an `ask` BrainEvent to the conversation's clients and parks a Promise keyed by a
 *  fresh question id; whichever client answers first calls `answer(id, …)` to settle it. Since a turn is
 *  single-threaded and parks on one `askUser` call, there is at most one pending entry per conversation. */
export class ElicitationRegistry {
  private readonly pending = new Map<string, Pending>();
  /** Per-session tail of the serialized APPROVAL chain: a new approval parks only after the previous one
   *  for the same conversation settles (see {@link ask}). Never rejects. */
  private readonly approvalChain = new Map<string, Promise<void>>();

  /** `timeoutMs` may be a fixed number or a resolver read per park, so an operator's config change to the
   *  elicitation limit takes effect on the next question without rebuilding the registry. */
  constructor(private readonly timeoutMs: number | (() => number) = DEFAULT_TIMEOUT_MS) {}

  /** Emit the question(s) to the conversation's clients and park until answered, timed out, or cancelled.
   *  `emit` fans the event into that conversation's listener set (SSE clients + Discord's in-process handler).
   *
   *  Two approval prompts can arise in ONE turn (parallel tool calls each needing sign-off). Those are
   *  SERIALIZED — the second parks only after the first settles — instead of the second superseding
   *  (cancelling) the first, which would reject the first's promise and be misread by the gate as a user
   *  deny. Regular AskUserQuestion calls keep the "one pending question per conversation" UX: a newer
   *  one drops the earlier. */
  ask(sessionId: string, questions: AskQuestion[], emit: (e: BrainEvent) => void, kind?: 'approval'): Promise<AskAnswer[]> {
    if (kind === 'approval') {
      const prev = this.approvalChain.get(sessionId);
      // No prior approval in flight → park now (synchronous emit, unchanged behaviour). Otherwise queue
      // behind it so both prompts get shown in turn rather than the newer one cancelling the older.
      const result = prev ? prev.then(() => this.park(sessionId, questions, emit, kind)) : this.park(sessionId, questions, emit, kind);
      const tail = result.then(() => {}, () => {}); // settles (either way) when this approval is done
      this.approvalChain.set(sessionId, tail);
      void tail.then(() => { if (this.approvalChain.get(sessionId) === tail) this.approvalChain.delete(sessionId); });
      return result;
    }
    // Enforce one pending question per conversation: if the model somehow fired two AskUserQuestion
    // calls in one turn, drop the earlier one (clients only show the latest anyway) so it can't linger.
    this.cancelForSession(sessionId, 'superseded by a newer question');
    return this.park(sessionId, questions, emit, kind);
  }

  /** Emit the question(s) and park a fresh promise keyed by a new question id until it is answered,
   *  timed out, or cancelled. */
  private park(sessionId: string, questions: AskQuestion[], emit: (e: BrainEvent) => void, kind?: 'approval'): Promise<AskAnswer[]> {
    const id = randomUUID();
    return new Promise<AskAnswer[]>((resolve, reject) => {
      const ms = typeof this.timeoutMs === 'function' ? this.timeoutMs() : this.timeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(questions.map((q) => ({ header: q.header, selected: NO_ANSWER })));
      }, ms);
      // Node keeps the event loop alive for pending timers; a parked question must not block process exit.
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, { sessionId, questions, kind, resolve, reject, timer });
      emit({ type: 'ask', id, questions, ...(kind ? { kind } : {}) });
    });
  }

  /** Settle a parked question with the user's picks. No-op on an unknown/already-settled id (tolerates a
   *  late double-click or a stale client answering an expired question). */
  answer(id: string, answers: AskAnswer[]): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(answers);
    return true;
  }

  /** The conversation a parked question belongs to, or undefined if unknown — used to authorize an
   *  inbound answer against the caller's own sessions. */
  sessionOf(id: string): string | undefined {
    return this.pending.get(id)?.sessionId;
  }

  /** The question currently parked for a conversation (there is at most one), or null — lets a client
   *  that reconnects mid-question (page refresh, SSE drop) re-render it instead of hanging silently. */
  pendingForSession(sessionId: string): { id: string; questions: AskQuestion[]; kind?: 'approval' } | null {
    for (const [id, p] of this.pending) if (p.sessionId === sessionId) return { id, questions: p.questions, ...(p.kind ? { kind: p.kind } : {}) };
    return null;
  }

  /** Reject every question parked for a conversation — called on turn abort / session dispose so a
   *  parked tool fails cleanly instead of hanging. */
  cancelForSession(sessionId: string, reason = 'turn cancelled'): void {
    for (const [id, p] of this.pending) {
      if (p.sessionId !== sessionId) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
  }

  /** Reject every parked question across all conversations — called when the whole live-session set is
   *  torn down (plugin reload / channel dispose-all) so no parked turn is left hanging on a dead session. */
  cancelAll(reason = 'sessions reset'): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.approvalChain.clear();
  }
}
