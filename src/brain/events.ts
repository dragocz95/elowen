import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { toolDetail } from './messageView.js';

/** What a channel (web/terminal/Discord) receives from the brain. Stable regardless of the underlying
 *  PI event shape — the mapping lives in one place (`toBrainEvent`). This is the wire contract every
 *  chat client folds: `text`, `idle` and `error` are the minimum a client must handle; everything else
 *  may be ignored. The shared reducer (`src/brain/transcript.ts`) is the reference implementation. */
export type BrainEvent =
  | { type: 'text'; delta: string }
  /** The model's reasoning/thinking stream (extended-thinking models) — shown as a dim, separate
   *  segment. Surfaced from PI's `thinking_delta`; channels may choose to ignore it. */
  | { type: 'reasoning'; delta: string }
  /** A tool call starting. `icon` is resolved daemon-side from the core map + plugin manifest `icons`
   *  (single source; clients render it, falling back to a generic glyph when absent). */
  | { type: 'tool'; name: string; detail?: string; icon?: string }
  | { type: 'diff'; diff: string }
  /** A structured display card a plugin pushed via `ctx.emitCard` — a live panel (CLI above the status
   *  bar, Discord in the streamed message, web in a cards region) keyed by `card.id` so a re-emit
   *  replaces it; an empty card (no items/body) removes it. Generalizes what the todo checklist used to
   *  do with its own bespoke event. */
  | { type: 'card'; card: BrainCard }
  /** A tool produced a stored image (`/api/brain/images/…`) — channels attach it even when the
   *  model's final text forgets to repeat the markdown link. */
  | { type: 'image'; ref: string }
  /** A transient runtime notice (rate-limit retry, context compaction) — so a stalled turn explains
   *  itself instead of just hanging on the spinner. `done` marks the end of that phase. */
  | { type: 'notice'; kind: 'retry' | 'compaction'; message: string; done?: boolean }
  /** The agent is asking the user to pick from predefined options and has PARKED the turn until they
   *  answer (see `ask_user_question` plugin + ElicitationRegistry). Synthetic — not derived from a PI
   *  event; the elicitor emits it straight into `listeners`. A client renders the questions as
   *  interactive choices and POSTs the answer to `/brain/answer` (Discord resolves it in-process). */
  | { type: 'ask'; id: string; questions: AskQuestion[] }
  /** A new agent step (one model round-trip / turn) started within the current run. `step` is 1-based;
   *  `maxSteps` is the configured ceiling (0 = unlimited). Clients render a `Step N / MAX` counter in
   *  their live status without spawning a new message. Synthetic — counted daemon-side, not a raw PI event. */
  | { type: 'step'; step: number; maxSteps: number }
  | { type: 'idle'; usage?: BrainUsage; model?: string }
  | { type: 'error'; message: string };

/** Result of a manual/auto context compaction. `compacted` is false when there was nothing to compact
 *  (session too small / already compacted) — a benign no-op the clients report as a friendly notice
 *  rather than an error. `usage` is always the fresh post-call context fill. */
export interface CompactResult { usage: BrainUsage; compacted: boolean; message?: string }

/** PI throws (not a status) when there's nothing to compact — a small/already-compacted session. Treat
 *  it as a benign no-op instead of a hard error so `/compact` never surfaces an opaque failure. */
function isNoopCompactError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /nothing to compact|already compacted|session too small/i.test(m);
}

/** Run a session compaction and normalize the no-op case into a benign result. `session` needs only the
 *  compact() call and a usage snapshot — shared by owner chat and channel sessions so both report
 *  "nothing to compact" identically. */
export async function runCompaction(session: AgentSession): Promise<CompactResult> {
  try {
    await session.compact();
    return { usage: usageOf(session), compacted: true };
  } catch (e) {
    if (isNoopCompactError(e)) return { usage: usageOf(session), compacted: false, message: 'Nothing to compact yet.' };
    throw e;
  }
}

/** One selectable option in an `ask` question. `description` is an optional one-line hint under the label. */
interface AskOption { label: string; description?: string }
/** A single multiple-choice question the agent poses via `ask_user_question`. `header` is a short chip
 *  label (≤12 chars); `multiSelect` allows more than one pick. Every question also implicitly offers a
 *  free-text "Other" escape, surfaced by each client. */
export interface AskQuestion { question: string; header: string; multiSelect: boolean; options: AskOption[] }
/** The user's answer to one question: the picked option label(s) plus an optional free-text "Other". */
export interface AskAnswer { header: string; selected: string[]; other?: string }

/** One row of a card's checklist. `status` drives the glyph (○ pending / ◐ in-progress / ✔ done). */
export interface BrainCardItem { text: string; status?: 'pending' | 'in_progress' | 'completed' }
/** A structured display panel a plugin pushes via `ctx.emitCard` — a generic, reusable replacement for
 *  the old bespoke todo widget. `id` is stable (a re-emit with the same id replaces the panel; an empty
 *  card removes it). `title` is the header; `items` a checklist; `body` freeform markdown; `pinned` asks
 *  the CLI to keep it above the status bar (the todo-panel behaviour) rather than letting it scroll. */
export interface BrainCard {
  id: string;
  title?: string;
  items?: BrainCardItem[];
  body?: string;
  pinned?: boolean;
}

/** Statusline data for one live conversation: current context fill + session totals. */
export interface BrainUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
  totalTokens: number;
  cost: number;
}

/** Translate a PI session event into the stable BrainEvent contract. Defensive: unknown event types
 *  are dropped. */
export function toBrainEvent(e: AgentSessionEvent): BrainEvent | null {
  if (e.type === 'agent_end') return { type: 'idle' };
  const anyE = e as {
    type: string; toolName?: string; args?: unknown; result?: { details?: { diff?: unknown } };
    assistantMessageEvent?: { type?: string; delta?: string };
    attempt?: number; maxAttempts?: number; errorMessage?: string; success?: boolean;
  };
  if (anyE.type === 'message_update') {
    const ev = anyE.assistantMessageEvent;
    if (ev?.type === 'text_delta' && ev.delta) return { type: 'text', delta: ev.delta };
    // The model's reasoning stream (extended-thinking models) — a first-class, separately-rendered event.
    if (ev?.type === 'thinking_delta' && ev.delta) return { type: 'reasoning', delta: ev.delta };
    return null;
  }
  // Runtime notices so a stalled turn explains itself instead of hanging silently on the spinner.
  if (anyE.type === 'auto_retry_start') {
    const detail = anyE.errorMessage ? ` (${String(anyE.errorMessage).slice(0, 80)})` : '';
    return { type: 'notice', kind: 'retry', message: `retrying${detail} — attempt ${anyE.attempt ?? 1}/${anyE.maxAttempts ?? 1}…` };
  }
  if (anyE.type === 'auto_retry_end') return { type: 'notice', kind: 'retry', message: anyE.success ? 'retry succeeded' : 'retry failed', done: true };
  if (anyE.type === 'compaction_start') return { type: 'notice', kind: 'compaction', message: 'compacting context…' };
  if (anyE.type === 'compaction_end') return { type: 'notice', kind: 'compaction', message: 'context compacted', done: true };
  // Emit the tool name ONCE, when it starts — never the raw streamed output (_update noise).
  if (anyE.type === 'tool_execution_start' && typeof anyE.toolName === 'string') {
    return { type: 'tool', name: anyE.toolName, detail: toolDetail(anyE.args) };
  }
  // Edits carry a display diff in their result details — that's the one tool output worth showing.
  if (anyE.type === 'tool_execution_end') {
    const diff = anyE.result?.details?.diff;
    if (typeof diff === 'string' && diff.trim()) return { type: 'diff', diff };
    // Image tools return a markdown link to the stored file; surface it as a first-class event so
    // channel adapters can attach the real file (models often omit the link from their final text).
    const parts = (anyE.result as { content?: { type?: string; text?: string }[] } | undefined)?.content;
    for (const part of Array.isArray(parts) ? parts : []) {
      const m = typeof part?.text === 'string' ? /\((\/api)?\/brain\/images\/([a-z0-9]+\.png)\)/.exec(part.text) : null;
      if (m) return { type: 'image', ref: `/api/brain/images/${m[2]}` };
    }
  }
  return null;
}

/** Snapshot a session's statusline numbers: context fill from PI plus per-message usage totals. */
export function usageOf(session: AgentSession): BrainUsage {
  const ctx = session.getContextUsage();
  let totalTokens = 0;
  let cost = 0;
  for (const m of session.messages as { usage?: { totalTokens?: number; cost?: { total?: number } } }[]) {
    totalTokens += m.usage?.totalTokens ?? 0;
    cost += m.usage?.cost?.total ?? 0;
  }
  return { tokens: ctx?.tokens ?? null, contextWindow: ctx?.contextWindow ?? 0, percent: ctx?.percent ?? null, totalTokens, cost };
}
