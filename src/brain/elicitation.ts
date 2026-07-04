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
  resolve: (answers: AskAnswer[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** In-memory registry of parked `ask_user_question` calls. One instance is owned by BrainService and
 *  serves every surface (web/CLI via `/brain/answer`, Discord in-process): a tool's `execute` awaits
 *  `ask()`, which emits an `ask` BrainEvent to the conversation's clients and parks a Promise keyed by a
 *  fresh question id; whichever client answers first calls `answer(id, …)` to settle it. Since a turn is
 *  single-threaded and parks on one `askUser` call, there is at most one pending entry per conversation. */
export class ElicitationRegistry {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS) {}

  /** Emit the question(s) to the conversation's clients and park until answered, timed out, or cancelled.
   *  `emit` fans the event into that conversation's listener set (SSE clients + Discord's in-process handler). */
  ask(sessionId: string, questions: AskQuestion[], emit: (e: BrainEvent) => void): Promise<AskAnswer[]> {
    // Enforce one pending question per conversation: if the model somehow fired two ask_user_question
    // calls in one turn, drop the earlier one (clients only show the latest anyway) so it can't linger.
    this.cancelForSession(sessionId, 'superseded by a newer question');
    const id = randomUUID();
    return new Promise<AskAnswer[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(questions.map((q) => ({ header: q.header, selected: NO_ANSWER })));
      }, this.timeoutMs);
      // Node keeps the event loop alive for pending timers; a parked question must not block process exit.
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, { sessionId, questions, resolve, reject, timer });
      emit({ type: 'ask', id, questions });
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
  pendingForSession(sessionId: string): { id: string; questions: AskQuestion[] } | null {
    for (const [id, p] of this.pending) if (p.sessionId === sessionId) return { id, questions: p.questions };
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
  }
}
