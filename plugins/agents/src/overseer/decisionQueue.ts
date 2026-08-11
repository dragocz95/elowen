import { randomBytes } from 'node:crypto';

export type DecisionKind = 'prompt' | 'review' | 'question' | 'message' | 'check';
export interface DecisionResult {
  approve: boolean;
  confidence: number;
  rationale: string;
  /** For a 'check' decision (the liveness sweep woke the overseer about an idle worker): the overseer
   *  wants the worker killed and relaunched (it judged it genuinely stuck, not just slow). Distinct from
   *  `message` (nudge it) and a bare `approve:false` (escalate to a human). */
  restart?: boolean;
  /** For a 'question' decision: the option id the overseer picked. Absent ⇒ escalate to a human
   *  (also the shape of a timeout/drain verdict, which therefore escalates the question). */
  choice?: string;
  /** For a 'message' decision (worker asked the autopilot a free-text question): the overseer's
   *  free-text reply. Absent ⇒ the overseer escalated (or timed out) → the ask falls to the human
   *  window. Distinct from `choice`/`approve`, which don't apply to a free-text exchange. */
  message?: string;
  /** True only when the overseer never answered (the decision timed out): there is NO real verdict,
   *  so the decision must be handed to a human and never auto-acted on. In particular a post-done
   *  review must NOT self-heal/re-run the phase on this — that turns a slow/absent overseer into an
   *  infinite reopen loop. A genuine overseer reject leaves this unset. */
  escalated?: boolean;
}
export interface PendingDecision { id: string; kind: DecisionKind; context: Record<string, unknown> }

interface Entry extends PendingDecision { settle: (r: DecisionResult) => void; enqueuedAt: number }
type Waiter = (r: PendingDecision | null) => void;
/** One unanswered decision, flattened for the liveness sweep (`decisionTimeout.ts`). */
export interface PendingEntry { missionId: string; id: string; kind: DecisionKind; enqueuedAt: number }

const HEARTBEAT_MS = 25_000;

/** Per-mission FIFO of decisions awaiting a verdict from the parked overseer agent. The engine/
 *  deriver `enqueue` (and await) a decision; the agent long-polls `next` and answers via `resolve`.
 *  Every enqueue is guaranteed to settle: by the agent, by the liveness sweep (`timeout`, when the
 *  overseer is gone or stuck past a ceiling), or by `drain` (mission gone). No model output is parsed
 *  here — the agent submits a structured verdict.
 *
 *  NB: enqueue does NOT arm a wall-clock deadline. A slow-but-alive overseer (e.g. a heavy review under
 *  claude opus) must not be escalated for merely thinking; only the out-of-band liveness sweep decides
 *  when an unanswered decision has truly gone unsupervised. */
export class DecisionQueue {
  private queues = new Map<string, Entry[]>();    // missionId → FIFO of unanswered requests
  private waiters = new Map<string, Waiter[]>();  // missionId → long-poll resolvers awaiting a request

  /** `now` is injectable so the sweep and tests can drive `enqueuedAt` deterministically. */
  constructor(private readonly now: () => number = Date.now) {}

  enqueue(missionId: string, kind: DecisionKind, context: Record<string, unknown>): Promise<DecisionResult> {
    return new Promise<DecisionResult>((resolveVerdict) => {
      const id = randomBytes(6).toString('hex');
      const entry: Entry = { id, kind, context, enqueuedAt: this.now(), settle: resolveVerdict };
      const list = this.queues.get(missionId) ?? [];
      list.push(entry);
      this.queues.set(missionId, list);
      this.wakeWaiter(missionId);
    });
  }

  /** All unanswered decisions across every mission, oldest-first per mission — the input the liveness
   *  sweep groups by mission to decide which (if any) to escalate. */
  pending(): PendingEntry[] {
    const out: PendingEntry[] = [];
    for (const [missionId, list] of this.queues) {
      for (const e of list) out.push({ missionId, id: e.id, kind: e.kind, enqueuedAt: e.enqueuedAt });
    }
    return out;
  }

  /** Escalate a still-pending decision to a human because its overseer is gone/stuck (the liveness
   *  sweep's verdict). Mirrors `resolve` but with the synthetic escalate-and-never-auto-act verdict;
   *  no-op (false) if the entry already settled, so it can't double-settle vs `resolve`/`drain`.
   *  `escalated: true` flags "no real overseer verdict" — consumers must hand it to a human and must
   *  NOT auto-act (e.g. an L3 review must not self-heal/re-run the phase on it, or it livelocks). */
  timeout(missionId: string, id: string): boolean {
    return this.resolve(missionId, id, { approve: false, confidence: 0, rationale: 'overseer timeout', escalated: true });
  }

  next(missionId: string, timeoutMs = HEARTBEAT_MS): Promise<PendingDecision | null> {
    const ready = (this.queues.get(missionId) ?? [])[0];
    if (ready) return Promise.resolve({ id: ready.id, kind: ready.kind, context: ready.context });
    return new Promise<PendingDecision | null>((resolve) => {
      const timer = setTimeout(() => { this.dropWaiter(missionId, w); resolve(null); }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      const w: Waiter = (req) => { clearTimeout(timer); resolve(req); };
      const list = this.waiters.get(missionId) ?? [];
      list.push(w);
      this.waiters.set(missionId, list);
    });
  }

  resolve(missionId: string, id: string, result: DecisionResult): boolean {
    const entry = (this.queues.get(missionId) ?? []).find((e) => e.id === id);
    if (!entry) return false;
    this.remove(missionId, id);
    entry.settle(result);
    return true;
  }

  drain(missionId: string): void {
    for (const e of this.queues.get(missionId) ?? []) e.settle({ approve: false, confidence: 0, rationale: 'mission disengaged' });
    this.queues.delete(missionId);
    for (const w of this.waiters.get(missionId) ?? []) w(null);
    this.waiters.delete(missionId);
  }

  private wakeWaiter(missionId: string): void {
    const w = (this.waiters.get(missionId) ?? []).shift();
    const head = (this.queues.get(missionId) ?? [])[0];
    if (w && head) w({ id: head.id, kind: head.kind, context: head.context });
  }

  private dropWaiter(missionId: string, w: Waiter): void {
    const list = (this.waiters.get(missionId) ?? []).filter((x) => x !== w);
    if (list.length) this.waiters.set(missionId, list); else this.waiters.delete(missionId);
  }

  private remove(missionId: string, id: string): void {
    const list = (this.queues.get(missionId) ?? []).filter((e) => e.id !== id);
    if (list.length) this.queues.set(missionId, list); else this.queues.delete(missionId);
  }
}
