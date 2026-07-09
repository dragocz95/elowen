import type { BrainCard, BrainMessage, ToolOutputView } from './types';

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
  | { type: 'tool'; name: string; detail?: string; icon?: string; id?: string }
  | { type: 'diff'; diff: string; id?: string }
  | { type: 'tool_output'; output: ToolOutputView; id?: string }
  | { type: 'notice'; kind: 'retry' | 'compaction'; message: string; done?: boolean }
  | { type: 'session'; sessionId: string }
  /** A server-delivered user message (a drained queued message never optimistically echoed) — folded as a
   *  'you' turn. See the daemon SessionQueue; the `queue` snapshot event is handled outside this fold. */
  | { type: 'user'; text: string }
  | { type: 'idle' }
  | { type: 'error'; message: string };

/** An assistant turn is an ordered list of segments so text and tool calls render in the sequence they
 *  happened. Consecutive tool calls (no new text between them) collapse into ONE tools segment → the
 *  Claude-Code "grouped pills" look. Useful tool output previews attach to their matching item. */
export interface ToolItem { name: string; detail?: string; diff?: string; icon?: string; output?: ToolOutputView; id?: string }
type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tools'; items: ToolItem[] };
/** A rendered tool group: consecutive items of the SAME tool with no diff and no output block fold into
 *  ONE pill showing the LAST item's detail plus a `×count` when >1 (mirror of the CLI's
 *  {@link groupToolItems}). Grouping lives in the RENDERER, not the fold, so the id-keyed diff/output
 *  attachment still lands on the right item and resumed history collapses for free. An item WITH a diff
 *  or an output block stays its own group (count 1) and renders its own block. */
export interface ToolGroup { item: ToolItem; count: number }

function isCollapsibleTool(item: ToolItem): boolean {
  return !item.diff && !item.output;
}

/** Fold a tools segment's items into render groups (see {@link ToolGroup}). Pure — recomputed every
 *  render so a streaming pill's count and latest detail stay live. */
export function groupToolItems(items: ToolItem[]): ToolGroup[] {
  const groups: ToolGroup[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && isCollapsibleTool(item) && isCollapsibleTool(last.item) && last.item.name === item.name) {
      groups[groups.length - 1] = { item, count: last.count + 1 };
    } else {
      groups.push({ item, count: 1 });
    }
  }
  return groups;
}

type YouTurn = { role: 'you'; text: string };
type ElowenTurn = { role: 'elowen'; segments: Segment[]; streaming: boolean };
/** A context-compaction boundary: everything before it was summarized away server-side, so the dock
 *  renders a subtle "context compacted" divider in its place, followed by the kept tail. */
type DividerTurn = { role: 'divider' };
export type ChatTurn = YouTurn | ElowenTurn | DividerTurn;

/** The whole view model the dock renders. `notice` is a transient runtime line (retry/compaction). */
export interface ChatView { turns: ChatTurn[]; thinking: boolean; notice?: string }

export const emptyView = (): ChatView => ({ turns: [], thinking: false });

/** Build the initial view from stored history (`GET /brain/messages`). Server-built segments preserve
 *  the true text/tool order; older rows fall back to a single flat text segment. */
export function fromHistory(msgs: BrainMessage[]): ChatView {
  const turns: ChatTurn[] = [];
  for (const m of msgs) {
    // A compaction boundary → a divider turn (the pre-compaction history was summarized away).
    if (m.role === 'compaction') { turns.push({ role: 'divider' }); continue; }
    if (m.role === 'user') {
      if (m.text.trim()) turns.push({ role: 'you', text: m.text });
      continue;
    }
    const segments: Segment[] = [];
    for (const seg of m.segments ?? (m.text.trim() ? [{ kind: 'text' as const, text: m.text }] : [])) {
      if (seg.kind === 'text') {
        segments.push({ kind: 'text', text: seg.text });
      } else {
        const item: ToolItem = { name: seg.name, detail: seg.detail, diff: seg.diff, output: seg.output };
        const tail = segments[segments.length - 1];
        if (tail?.kind === 'tools') tail.items.push(item);
        else segments.push({ kind: 'tools', items: [item] });
      }
    }
    if (segments.length > 0) turns.push({ role: 'elowen', segments, streaming: false });
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
  const ensureElowen = (): ElowenTurn => {
    const last = turns[turns.length - 1];
    if (last && last.role === 'elowen' && last.streaming) {
      const clone: ElowenTurn = { role: 'elowen', segments: [...last.segments], streaming: true };
      turns[turns.length - 1] = clone;
      return clone;
    }
    const fresh: ElowenTurn = { role: 'elowen', segments: [], streaming: true };
    turns.push(fresh);
    return fresh;
  };
  const addText = (t: ElowenTurn, delta: string): void => {
    const tail = t.segments[t.segments.length - 1];
    if (tail?.kind === 'text') t.segments[t.segments.length - 1] = { kind: 'text', text: tail.text + delta };
    else t.segments.push({ kind: 'text', text: delta });
  };
  const addReasoning = (t: ElowenTurn, delta: string): void => {
    const tail = t.segments[t.segments.length - 1];
    if (tail?.kind === 'reasoning') t.segments[t.segments.length - 1] = { kind: 'reasoning', text: tail.text + delta };
    else t.segments.push({ kind: 'reasoning', text: delta });
  };
  switch (e.type) {
    case 'text': {
      addText(ensureElowen(), e.delta);
      return { turns, thinking: true, notice: undefined };
    }
    case 'reasoning': {
      addReasoning(ensureElowen(), e.delta);
      return { turns, thinking: true, notice: view.notice };
    }
    case 'notice': {
      return { turns, thinking: view.thinking, notice: e.done ? undefined : e.message };
    }
    case 'tool': {
      const t = ensureElowen();
      const item: ToolItem = { name: e.name, detail: e.detail, icon: e.icon, ...(e.id ? { id: e.id } : {}) };
      const tail = t.segments[t.segments.length - 1];
      if (tail?.kind === 'tools') t.segments[t.segments.length - 1] = { kind: 'tools', items: [...tail.items, item] };
      else t.segments.push({ kind: 'tools', items: [item] });
      return { turns, thinking: true, notice: view.notice };
    }
    case 'diff': {
      const t = ensureElowen();
      attachToTool(t, e.id, (item) => ({ ...item, diff: e.diff }));
      return { turns, thinking: true, notice: view.notice };
    }
    case 'tool_output': {
      const t = ensureElowen();
      attachToTool(t, e.id, (item) => ({ ...item, output: e.output }));
      return { turns, thinking: true, notice: view.notice };
    }
    case 'session': {
      // Idle rollover mid-send: the server moved this message into a FRESH conversation. Reset the
      // transcript — the daemon re-emits the triggering message as a `user` event and streams its reply,
      // so the fresh conversation rebuilds purely from the stream (no optimistic local 'you' to preserve).
      return { turns: [], thinking: view.thinking, notice: view.notice };
    }
    case 'user': {
      // The daemon's authoritative render of the user's turn (every real user send — normal or queued
      // delivery). The client no longer echoes optimistically, so this is what shows the 'you' bubble.
      return { turns: [...turns, { role: 'you', text: e.text }], thinking: true, notice: view.notice };
    }
    case 'idle': {
      const last = turns[turns.length - 1];
      if (last && last.role === 'elowen') turns[turns.length - 1] = { ...last, streaming: false };
      return { turns, thinking: false, notice: undefined };
    }
    case 'error': {
      const t = ensureElowen();
      addText(t, `\n[error: ${e.message}]`);
      t.streaming = false;
      return { turns, thinking: false, notice: undefined };
    }
    default:
      return view;
  }
}

function attachToTool(t: ElowenTurn, id: string | undefined, patch: (item: ToolItem) => ToolItem): void {
  for (let i = t.segments.length - 1; i >= 0; i--) {
    const seg = t.segments[i]!;
    if (seg.kind !== 'tools') continue;
    const index = id ? seg.items.findIndex((item) => item.id === id) : seg.items.length - 1;
    if (index < 0) continue;
    const items = seg.items.slice();
    items[index] = patch(items[index]!);
    t.segments[i] = { kind: 'tools', items };
    return;
  }
}

/** Fold a live `card` event into the card list: replace by id, append when new, drop when it came back
 *  empty (a cleared panel). Mirrors the daemon `isEmptyCard`: a card with neither items nor body removes. */
export function upsertCard(cards: BrainCard[], card: BrainCard): BrainCard[] {
  const rest = cards.filter((c) => c.id !== card.id);
  const empty = (!card.items || card.items.length === 0) && !card.body;
  return empty ? rest : [...rest, card];
}
