import type { BrainCard, BrainEvent } from './events.js';
import { isEmptyCard } from './cards.js';

/** The shared, UI-free transcript model + fold. This is the single source the chat surfaces build their
 *  view from: the CLI TUI (`src/cli/chat`) imports it directly; the web dock mirrors it in
 *  `web/lib/transcript.ts` (a separate browser bundle can't import daemon NodeNext source — see that
 *  file's note). Pure data: nothing here touches a terminal, React or Discord.
 *
 *  An assistant turn is an ordered list of segments so text and tool calls render in the sequence they
 *  happened. Consecutive tool calls (no new text between them) collapse into ONE tools segment — the
 *  Claude-Code "grouped" look. Tool OUTPUT is never shown; only names, argument summaries and edit diffs. */
export interface ToolItem { name: string; detail?: string; diff?: string; icon?: string }
export type Segment =
  | { kind: 'text'; text: string }
  /** The model's reasoning/thinking stream — rendered dim + separate from the answer. */
  | { kind: 'reasoning'; text: string }
  | { kind: 'tools'; items: ToolItem[] };
export type YouTurn = { role: 'you'; text: string };
export type OrcaTurn = { role: 'orca'; segments: Segment[]; streaming: boolean };
export type ChatTurn = YouTurn | OrcaTurn;

/** The whole view model a surface renders. Pure data — the fold never touches the terminal. `notice`
 *  is a transient runtime line (retry/compaction) cleared when the turn goes idle. */
export interface ChatView { turns: ChatTurn[]; thinking: boolean; notice?: string }

/** One stored turn as `fromHistory` consumes it. Structurally the `BrainMessageView` the daemon serves
 *  (`GET /brain/messages`) and the web's `BrainMessage` — a flat `text` plus optional ordered `segments`. */
export interface HistoryMessage {
  role: string;
  text: string;
  segments?: ({ kind: 'text'; text: string } | { kind: 'tool'; name: string; detail?: string; diff?: string })[];
}

export const emptyView = (): ChatView => ({ turns: [], thinking: false });

/** Build the initial view from stored history. Assistant turns keep their server-built segments
 *  (ordered text + tool calls with diffs), so a resumed conversation looks exactly like a live one. */
export function fromHistory(msgs: HistoryMessage[]): ChatView {
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

/** Append the user's turn (finalized) — called optimistically when they hit enter. */
export function pushUser(view: ChatView, text: string): ChatView {
  return { ...view, turns: [...view.turns, { role: 'you', text }] };
}

/** Open a fresh streaming assistant turn and switch on the thinking indicator. */
export function beginAssistant(view: ChatView): ChatView {
  return { thinking: true, turns: [...view.turns, { role: 'orca', segments: [], streaming: true }] };
}

/** Fold one brain event into the view. Pure: returns a new ChatView, never mutates the input. Handles
 *  the turn-affecting events (`text`/`reasoning`/`tool`/`diff`/`notice`/`idle`/`error`); a surface routes
 *  the out-of-band events (`card`/`ask`) through `upsertCard` and its own question state instead. */
export function reduce(view: ChatView, e: BrainEvent): ChatView {
  const turns = view.turns.slice();
  // Return a live streaming assistant turn, creating one if the last turn isn't it.
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
      return { turns, thinking: true, notice: undefined }; // first answer text clears any transient notice
    }
    case 'reasoning': {
      addReasoning(ensureOrca(), e.delta);
      return { turns, thinking: true, notice: view.notice };
    }
    case 'notice': {
      // Transient runtime line (retry/compaction); `done` clears it, otherwise it shows until the next.
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
      // An edit finished — attach its diff to the most recent tool call of the streaming turn.
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
      return { turns, thinking: false, notice: undefined }; // turn settled → drop any transient notice
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

/** Fold a live `card` event into a card list: replace by id, append when new, or drop when the card came
 *  back empty (a cleared panel). Shared by every surface's card region. */
export function upsertCard(cards: BrainCard[], card: BrainCard): BrainCard[] {
  const rest = cards.filter((c) => c.id !== card.id);
  return isEmptyCard(card) ? rest : [...rest, card];
}
