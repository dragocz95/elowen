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
  /** Kept from `park` so every exit can announce itself on the same fan-out the question arrived on.
   *  Without it a surface that did not answer keeps showing a prompt nobody can settle any more. */
  emit: (e: BrainEvent) => void;
}

interface ApprovalState {
  tail: Promise<void>;
  cancellation: { error: Error | null };
}

/** Validate an untrusted surface payload against the exact questions that are still pending. Labels are
 * the wire identity, so an unknown/duplicate pick, a reordered header, or custom text the question did not
 * allow is a mismatch, not input to normalize. Fail closed without settling the parked Promise. */
function answersMatch(questions: readonly AskQuestion[], answers: unknown): answers is AskAnswer[] {
  if (!Array.isArray(answers) || answers.length !== questions.length) return false;
  return answers.every((raw, index) => {
    const question = questions[index];
    if (!question || !raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const answer = raw as { header?: unknown; selected?: unknown; other?: unknown };
    if (answer.header !== question.header || !Array.isArray(answer.selected)) return false;
    if (!answer.selected.every((label): label is string => typeof label === 'string')) return false;
    const selected = answer.selected as string[];
    const hasOther = typeof answer.other === 'string' && answer.other.trim().length > 0;
    if (selected.length === 0 && !hasOther) return false;
    const distinct = new Set(selected);
    if (distinct.size !== selected.length) return false;
    if (!question.multiSelect && selected.length > 1) return false;
    if (selected.length > question.options.length) return false;
    const allowed = new Set(question.options.map((option) => option.label));
    if (selected.some((label) => !allowed.has(label))) return false;
    if (answer.other !== undefined) {
      if (question.custom === false || typeof answer.other !== 'string') return false;
    }
    return true;
  });
}

/** In-memory registry of parked `AskUserQuestion` calls. One instance is owned by BrainService and
 *  serves every surface (owner clients via `/brain/answer`, platform adapters in-process): a tool's `execute` awaits
 *  `ask()`, which emits an `ask` BrainEvent to the conversation's clients and parks a Promise keyed by a
 *  fresh question id; whichever client answers first calls `answer(id, …)` to settle it. Since a turn is
 *  single-threaded and parks on one `askUser` call, there is at most one pending entry per conversation. */
export class ElicitationRegistry {
  private readonly pending = new Map<string, Pending>();
  /** Per-session serialized APPROVAL state. Every queued approval captures the shared cancellation token,
   *  so aborting the session invalidates deferred parks before their `then` callback can emit. */
  private readonly approvalStates = new Map<string, ApprovalState>();

  /** `timeoutMs` may be a fixed number or a resolver read per park, so an operator's config change to the
   *  elicitation limit takes effect on the next question without rebuilding the registry. */
  constructor(private readonly timeoutMs: number | (() => number) = DEFAULT_TIMEOUT_MS) {}

  /** Emit the question(s) to the conversation's clients and park until answered, timed out, or cancelled.
   *  `emit` fans the event into that conversation's listener set (SSE clients and platform handlers).
   *
   *  Two approval prompts can arise in ONE turn (parallel tool calls each needing sign-off). Those are
   *  SERIALIZED — the second parks only after the first settles — instead of the second superseding
   *  (cancelling) the first, which would reject the first's promise and be misread by the gate as a user
   *  deny. Regular AskUserQuestion calls keep the "one pending question per conversation" UX: a newer
   *  one drops the earlier. */
  ask(sessionId: string, questions: AskQuestion[], emit: (e: BrainEvent) => void, kind?: 'approval'): Promise<AskAnswer[]> {
    if (kind === 'approval') {
      const previous = this.approvalStates.get(sessionId);
      const cancellation = previous?.cancellation ?? { error: null };
      const park = (): Promise<AskAnswer[]> => cancellation.error
        ? Promise.reject(cancellation.error)
        : this.park(sessionId, questions, emit, kind);
      // No prior approval in flight → park now (synchronous emit, unchanged behaviour). Otherwise queue
      // behind it so both prompts get shown in turn rather than the newer one cancelling the older.
      const result = previous ? previous.tail.then(park) : park();
      const state: ApprovalState = {
        cancellation,
        tail: result.then(() => {}, () => {}),
      };
      this.approvalStates.set(sessionId, state);
      void state.tail.then(() => {
        if (this.approvalStates.get(sessionId) === state) this.approvalStates.delete(sessionId);
      });
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
        emit({ type: 'ask_resolved', id, reason: 'timeout' });
        resolve(questions.map((q) => ({ header: q.header, selected: NO_ANSWER })));
      }, ms);
      // Node keeps the event loop alive for pending timers; a parked question must not block process exit.
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, { sessionId, questions, kind, resolve, reject, timer, emit });
      emit({ type: 'ask', id, questions, ...(kind ? { kind } : {}) });
    });
  }

  /** Settle a parked question only when the payload matches its exact questions. Unknown, stale, or invalid
   * answers are no-ops, so a late click is harmless and a malformed payload cannot consume the prompt. */
  answer(id: string, answers: AskAnswer[]): boolean {
    const p = this.pending.get(id);
    if (!p || !answersMatch(p.questions, answers)) return false;
    this.pending.delete(id);
    clearTimeout(p.timer);
    // Announced BEFORE resolve: resolving lets the parked turn run on, and its first events must not
    // reach a surface still showing a question the turn has already moved past. The delete above keeps
    // a /brain/status racing this consistent either way.
    p.emit({ type: 'ask_resolved', id, reason: 'answered' });
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
    const approval = this.approvalStates.get(sessionId);
    if (approval) {
      approval.cancellation.error = new Error(reason);
      this.approvalStates.delete(sessionId);
    }
    for (const [id, p] of this.pending) {
      if (p.sessionId !== sessionId) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.emit({ type: 'ask_resolved', id, reason: 'cancelled' });
      p.reject(new Error(reason));
    }
  }

  /** Reject every parked question across all conversations — called when the whole live-session set is
   *  torn down (plugin reload / channel dispose-all) so no parked turn is left hanging on a dead session. */
  cancelAll(reason = 'sessions reset'): void {
    for (const state of this.approvalStates.values()) state.cancellation.error = new Error(reason);
    this.approvalStates.clear();
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.emit({ type: 'ask_resolved', id, reason: 'cancelled' });
      p.reject(new Error(reason));
    }
  }
}
