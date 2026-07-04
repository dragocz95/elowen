import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { toolDetail } from './messageView.js';
import { normalizeTodos, type TodoItem } from './todos.js';

/** What a channel (web/terminal/Discord) receives from the brain. Stable regardless of the underlying
 *  PI event shape — the mapping lives in one place (`toBrainEvent`). This is the wire contract every
 *  chat client folds: `text`, `idle` and `error` are the minimum a client must handle; everything else
 *  may be ignored. The CLI reducer (`src/cli/chat/render.ts`) is the reference implementation. */
export type BrainEvent =
  | { type: 'text'; delta: string }
  /** The model's reasoning/thinking stream (extended-thinking models) — shown as a dim, separate
   *  segment. Surfaced from PI's `thinking_delta`; channels may choose to ignore it. */
  | { type: 'reasoning'; delta: string }
  | { type: 'tool'; name: string; detail?: string }
  | { type: 'diff'; diff: string }
  /** The current todo checklist a tool produced on `result.details.todos` — rendered as a live panel
   *  (CLI above the status bar, Discord in the streamed message), NOT inline under the tool. An empty
   *  list clears the panel. Mirrors how `diff` is lifted off a tool result. */
  | { type: 'todo'; todos: TodoItem[] }
  /** A tool produced a stored image (`/api/brain/images/…`) — channels attach it even when the
   *  model's final text forgets to repeat the markdown link. */
  | { type: 'image'; ref: string }
  /** A transient runtime notice (rate-limit retry, context compaction) — so a stalled turn explains
   *  itself instead of just hanging on the spinner. `done` marks the end of that phase. */
  | { type: 'notice'; kind: 'retry' | 'compaction'; message: string; done?: boolean }
  | { type: 'idle'; usage?: BrainUsage; model?: string }
  | { type: 'error'; message: string };

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
    type: string; toolName?: string; args?: unknown; result?: { details?: { diff?: unknown; todos?: unknown } };
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
    // A todo tool publishes its full list on `details.todos` — surface it as a live panel event.
    const todos = anyE.result?.details?.todos;
    if (Array.isArray(todos)) return { type: 'todo', todos: normalizeTodos(todos) };
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
