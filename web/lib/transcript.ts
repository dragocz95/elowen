import type { BrainCard, BrainMessage } from './types';

/** Browser MIRROR of the daemon's `src/brain/transcript.ts` (same governance as `web/lib/types.ts`
 *  mirroring `src/brain/events.ts`): the web dock is a standalone Next.js bundle whose Turbopack build
 *  can't import the daemon's NodeNext source (its `./x.js` import specifiers resolve to `.ts` files that
 *  don't exist on disk as `.js`). So this file is a faithful, hand-synced copy of the shared fold — keep
 *  the two in lockstep. Pure data: the React layer folds SSE events through `reduce`/`upsertCard` and
 *  reads the resulting `ChatView`, exactly like the CLI TUI. */

/** The turn-affecting brain events this fold handles (mirror of the `src/brain/events.ts` union subset;
 *  the out-of-band `card`/`ask` events are folded via `upsertCard` + the component's own question state). */
export type TranscriptEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool'; name: string; detail?: string; icon?: string }
  | { type: 'diff'; diff: string }
  | { type: 'notice'; kind: 'retry' | 'compaction'; message: string; done?: boolean }
  | { type: 'idle' }
  | { type: 'error'; message: string };

/** An assistant turn is an ordered list of segments so text and tool calls render in the sequence they
 *  happened. Consecutive tool calls (no new text between them) collapse into ONE tools segment → the
 *  Claude-Code "grouped pills" look. Tool OUTPUT is never shown; only names, argument summaries, diffs. */
export interface ToolItem { name: string; detail?: string; diff?: string; icon?: string }
export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tools'; items: ToolItem[] };
export type YouTurn = { role: 'you'; text: string };
export type OrcaTurn = { role: 'orca'; segments: Segment[]; streaming: boolean };
export type ChatTurn = YouTurn | OrcaTurn;

/** The whole view model the dock renders. `notice` is a transient runtime line (retry/compaction). */
export interface ChatView { turns: ChatTurn[]; thinking: boolean; notice?: string }

export const emptyView = (): ChatView => ({ turns: [], thinking: false });

/** Build the initial view from stored history (`GET /brain/messages`). Server-built segments preserve
 *  the true text/tool order; older rows fall back to a single flat text segment. */
export function fromHistory(msgs: BrainMessage[]): ChatView {
  const turns: ChatTurn[] = [];
  for (const m of msgs) {
    if (m.role === 'user') {
      if (m.text.trim()) turns.push({ role: 'you', text: m.text });
      continue;
    }
    const segments: Segment[] = [];
    for (const seg of m.segments ?? (m.text.trim() ? [{ kind: 'text' as const, text: m.text }] : [])) {
      if (seg.kind === 'text') {
        segments.push({ kind: 'text', text: seg.text });
      } else {
        const item: ToolItem = { name: seg.name, detail: seg.detail, diff: seg.diff };
        const tail = segments[segments.length - 1];
        if (tail?.kind === 'tools') tail.items.push(item);
        else segments.push({ kind: 'tools', items: [item] });
      }
    }
    if (segments.length > 0) turns.push({ role: 'orca', segments, streaming: false });
  }
  return { turns, thinking: false };
}

/** Append the user's turn (finalized) — called optimistically when they hit send. */
export function pushUser(view: ChatView, text: string): ChatView {
  return { ...view, turns: [...view.turns, { role: 'you', text }] };
}

/** Fold one brain event into the view. Pure: returns a new ChatView, never mutates the input. */
export function reduce(view: ChatView, e: TranscriptEvent): ChatView {
  const turns = view.turns.slice();
  const ensureOrca = (): OrcaTurn => {
    const last = turns[turns.length - 1];
    if (last && last.role === 'orca' && last.streaming) {
      const clone: OrcaTurn = { role: 'orca', segments: [...last.segments], streaming: true };
      turns[turns.length - 1] = clone;
      return clone;
    }
    const fresh: OrcaTurn = { role: 'orca', segments: [], streaming: true };
    turns.push(fresh);
    return fresh;
  };
  const addText = (t: OrcaTurn, delta: string): void => {
    const tail = t.segments[t.segments.length - 1];
    if (tail?.kind === 'text') t.segments[t.segments.length - 1] = { kind: 'text', text: tail.text + delta };
    else t.segments.push({ kind: 'text', text: delta });
  };
  const addReasoning = (t: OrcaTurn, delta: string): void => {
    const tail = t.segments[t.segments.length - 1];
    if (tail?.kind === 'reasoning') t.segments[t.segments.length - 1] = { kind: 'reasoning', text: tail.text + delta };
    else t.segments.push({ kind: 'reasoning', text: delta });
  };
  switch (e.type) {
    case 'text': {
      addText(ensureOrca(), e.delta);
      return { turns, thinking: true, notice: undefined };
    }
    case 'reasoning': {
      addReasoning(ensureOrca(), e.delta);
      return { turns, thinking: true, notice: view.notice };
    }
    case 'notice': {
      return { turns, thinking: view.thinking, notice: e.done ? undefined : e.message };
    }
    case 'tool': {
      const t = ensureOrca();
      const item: ToolItem = { name: e.name, detail: e.detail, icon: e.icon };
      const tail = t.segments[t.segments.length - 1];
      if (tail?.kind === 'tools') t.segments[t.segments.length - 1] = { kind: 'tools', items: [...tail.items, item] };
      else t.segments.push({ kind: 'tools', items: [item] });
      return { turns, thinking: true, notice: view.notice };
    }
    case 'diff': {
      const t = ensureOrca();
      for (let i = t.segments.length - 1; i >= 0; i--) {
        const seg = t.segments[i]!;
        if (seg.kind !== 'tools') continue;
        const items = seg.items.slice();
        items[items.length - 1] = { ...items[items.length - 1]!, diff: e.diff };
        t.segments[i] = { kind: 'tools', items };
        break;
      }
      return { turns, thinking: true, notice: view.notice };
    }
    case 'idle': {
      const last = turns[turns.length - 1];
      if (last && last.role === 'orca') turns[turns.length - 1] = { ...last, streaming: false };
      return { turns, thinking: false, notice: undefined };
    }
    case 'error': {
      const t = ensureOrca();
      addText(t, `\n[error: ${e.message}]`);
      t.streaming = false;
      return { turns, thinking: false, notice: undefined };
    }
    default:
      return view;
  }
}

/** Fold a live `card` event into the card list: replace by id, append when new, drop when it came back
 *  empty (a cleared panel). Mirrors the daemon `isEmptyCard`: a card with neither items nor body removes. */
export function upsertCard(cards: BrainCard[], card: BrainCard): BrainCard[] {
  const rest = cards.filter((c) => c.id !== card.id);
  const empty = (!card.items || card.items.length === 0) && !card.body;
  return empty ? rest : [...rest, card];
}
