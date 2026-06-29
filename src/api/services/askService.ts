import { randomBytes } from 'node:crypto';
import type { DecisionQueue } from '../../overseer/decisionQueue.js';
import type { ServerDeps } from '../deps.js';

/** One poll's max hold before returning a heartbeat so the worker's CLI re-polls (mirrors the overseer
 *  long-poll heartbeat). Kept under common proxy idle timeouts. */
const POLL_HEARTBEAT_MS = 25_000;
/** How many of the most recent conversation turns the overseer is handed as context. */
const HISTORY_TURNS = 30;
/** Grace period after an exchange SETTLES before its in-memory entry is evicted, so a late re-poll (or
 *  the route's access gate) still resolves it before it's GC'd. (An exchange parked on a human that is
 *  never answered is held until it settles — by design: it stays on the Escalations page until a person
 *  replies. That set is human-scale, bounded by the count of open escalations, not by agent traffic.) */
const SETTLED_TTL_MS = 2 * 60_000;

/** Delivered to the agent when neither the autopilot nor a human gave a decisive answer in time. Tells
 *  it to proceed on its own judgement rather than hang — matches the worker prompt's stuck guidance. */
export const ASK_SENTINEL =
  'No decisive answer was available from the autopilot or a human in time. Proceed using your own best judgement: make the safest reasonable, reversible assumption, note it in your task summary, and continue.';

type AskRole = 'agent' | 'autopilot' | 'human';

interface Exchange {
  taskId: string;
  /** The agent's question — surfaced to the human while the window is open. */
  question: string;
  /** Set once the exchange settles (overseer reply / human reply / sentinel). */
  finalText?: string;
  /** Long-poll waiters parked on `poll`, woken when the exchange settles. */
  pollWaiters: Array<(text: string) => void>;
  /** Resolver for the human window, present only while it is open (post-escalation). */
  humanResolve?: (text: string) => void;
  /** When the question was escalated to a human (ms epoch), so the inbox can show how long it's waited. */
  openedAt?: number;
}

/** A worker question parked on a human, awaiting a reply (no auto-fallback — the agent waits). */
interface PendingAsk {
  askId: string;
  taskId: string;
  question: string;
  since: number;
}

export interface AskServiceDeps {
  d: ServerDeps;
  decisionQueue: DecisionQueue;
}

export interface AskService {
  /** Worker posts a free-text question for the autopilot. Records it on the task, kicks off the async
   *  resolution (overseer → human window → sentinel) and returns the ask id the worker then polls. */
  start(taskId: string, question: string): { askId: string };
  /** Long-poll for the final reply. Resolves with the text once settled, or null on a heartbeat. */
  poll(askId: string, timeoutMs?: number): Promise<string | null>;
  /** Human (UI / curl) answers an open question. Returns false when there's nothing to answer. */
  reply(askId: string, text: string): boolean;
  /** The task an ask id belongs to (for the route's per-project access gate), or null if unknown. */
  taskFor(askId: string): string | null;
  /** Every ask currently parked on its human window (escalated / no overseer), for the Escalations inbox. */
  pending(): PendingAsk[];
}

/** The free-text worker↔autopilot exchange behind `orca ask`. Bridges the worker's long-poll to the
 *  parked overseer's decision queue (kind 'message'); on escalate/timeout/no-overseer it parks the
 *  question on a HUMAN and waits — no auto-answer, no sentinel fallback (the worker holds until a person
 *  replies on the Escalations page, or its own tool timeout gives up). Each turn (question + reply) is
 *  published as a `message` event on the task so the detail pane renders the conversation. */
export function createAskService({ d, decisionQueue }: AskServiceDeps): AskService {
  const exchanges = new Map<string, Exchange>();

  function record(taskId: string, role: AskRole, text: string): void {
    d.bus.publish({ type: 'message', taskId, role, text });
  }
  /** Transient ping so the Escalations inbox refetches its pending-ask list (open ↔ resolved). Not
   *  persisted — the `message` turns are the durable record; this only nudges the live view. */
  function pingPending(taskId: string): void {
    d.bus.publish({ type: 'ask', taskId });
  }

  function finalize(askId: string, role: AskRole, text: string): void {
    const ex = exchanges.get(askId);
    if (!ex || ex.finalText !== undefined) return; // already settled — ignore a late second resolver
    const wasOpen = !!ex.humanResolve;
    ex.humanResolve = undefined;
    ex.finalText = text;
    record(ex.taskId, role, text);
    if (wasOpen) pingPending(ex.taskId); // a parked ask just cleared — drop it from the inbox
    for (const w of ex.pollWaiters.splice(0)) w(text);
    // Evict after a grace window: late re-polls and the access gate still resolve, then it's GC'd so
    // a long-lived daemon doesn't accumulate settled exchanges forever.
    const evict = setTimeout(() => exchanges.delete(askId), SETTLED_TTL_MS);
    if (typeof evict.unref === 'function') evict.unref();
  }

  /** Hand the question to a human and WAIT — no auto-proceed. Used when the overseer escalates/times out,
   *  or there is no overseer at all. The ask now stands as a pending escalation in the inbox until a human
   *  answers it (or the worker's own tool timeout kills its blocking call). This mirrors every other Orca
   *  escalation: the autopilot stops and waits for a person rather than guessing on the agent's behalf. */
  function escalateToHuman(askId: string): void {
    const ex = exchanges.get(askId);
    if (!ex || ex.finalText !== undefined) return;
    ex.humanResolve = (text) => finalize(askId, 'human', text);
    ex.openedAt = d.clock.now();
    pingPending(ex.taskId); // surface it on the Escalations inbox
  }

  /** The task's conversation so far (every `message` turn, oldest-first) so the overseer answers with
   *  full context instead of a single isolated question. Kept to the MOST RECENT turns so the just-asked
   *  question is always included — `list` with a target is ordered oldest-first, so slice from the tail. */
  function history(taskId: string): { role: AskRole; text: string }[] {
    const turns = (d.events?.list({ target: taskId, type: 'message' }) ?? [])
      .map((e) => { try { const p = JSON.parse(e.detail) as { role: AskRole; text: string }; return p.role && typeof p.text === 'string' ? p : null; } catch { return null; } })
      .filter((p): p is { role: AskRole; text: string } => p !== null);
    return turns.slice(-HISTORY_TURNS); // newest turns, still oldest-first within the window
  }

  async function resolveExchange(askId: string, taskId: string, question: string): Promise<void> {
    // Only an ACTIVE mission with a parked overseer can answer; otherwise escalate straight to a human
    // (waiting out the decision timeout for an overseer that will never poll is pointless).
    const task = d.tasks.get(taskId);
    const mission = task?.parent_id ? d.missions.activeForEpic(task.parent_id) ?? undefined : undefined;
    const overseerParked = !!mission && !!d.config.get().autopilot.overseerExec;
    if (overseerParked) {
      // Hand the overseer the whole thread (the just-asked question is its last entry) so it can answer
      // a follow-up in context, not just the latest line in isolation.
      const verdict = await decisionQueue.enqueue(mission!.id, 'message', { question, taskId, history: history(taskId) });
      const reply = verdict.message?.trim();
      if (reply) { finalize(askId, 'autopilot', reply); return; }
      // No reply ⇒ the overseer escalated or timed out → hand it to a human.
    }
    escalateToHuman(askId);
  }

  function start(taskId: string, question: string): { askId: string } {
    const askId = randomBytes(6).toString('hex');
    exchanges.set(askId, { taskId, question, pollWaiters: [] });
    record(taskId, 'agent', question);
    // Fire-and-forget: the worker polls for the result. enqueue always settles, but guard anyway so a
    // thrown resolver doesn't strand the exchange — fall back to a human escalation, never an auto-answer.
    void resolveExchange(askId, taskId, question).catch(() => escalateToHuman(askId));
    return { askId };
  }

  function poll(askId: string, timeoutMs = POLL_HEARTBEAT_MS): Promise<string | null> {
    const ex = exchanges.get(askId);
    if (!ex) return Promise.resolve(ASK_SENTINEL); // unknown/expired id (e.g. daemon restart) — unblock the worker, don't hang
    if (ex.finalText !== undefined) return Promise.resolve(ex.finalText);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        ex.pollWaiters = ex.pollWaiters.filter((w) => w !== waiter);
        resolve(null); // heartbeat — the CLI re-polls
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      const waiter = (text: string) => { clearTimeout(timer); resolve(text); };
      ex.pollWaiters.push(waiter);
    });
  }

  function reply(askId: string, text: string): boolean {
    const ex = exchanges.get(askId);
    if (!ex || ex.finalText !== undefined || !ex.humanResolve) return false;
    ex.humanResolve(text);
    return true;
  }

  function taskFor(askId: string): string | null {
    return exchanges.get(askId)?.taskId ?? null;
  }

  function pending(): PendingAsk[] {
    const out: PendingAsk[] = [];
    for (const [askId, ex] of exchanges) {
      if (ex.finalText === undefined && ex.humanResolve) {
        out.push({ askId, taskId: ex.taskId, question: ex.question, since: ex.openedAt ?? 0 });
      }
    }
    return out;
  }

  return { start, poll, reply, taskFor, pending };
}
