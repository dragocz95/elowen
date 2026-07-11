import type { BrainCard, BrainEvent } from './events.js';
import { isEmptyCard } from './cards.js';
import type { ToolOutputView } from './messageView.js';

/** The shared, UI-free transcript model + fold. This is the single source the chat surfaces build their
 *  view from: the CLI TUI (`src/cli/chat`) imports it directly; the web dock mirrors it in
 *  `web/lib/transcript.ts` (a separate browser bundle can't import daemon NodeNext source — see that
 *  file's note). Pure data: nothing here touches a terminal, React or Discord.
 *
 *  An assistant turn is an ordered list of segments so text and tool calls render in the sequence they
 *  happened. Consecutive tool calls (no new text between them) collapse into ONE tools segment — the
 *  Claude-Code "grouped" look. Tool outputs are attached only when the daemon marks a compact preview
 *  as useful enough to show (tests, shell errors, browser/search observations). */
export interface ToolItem { name: string; detail?: string; diff?: string; icon?: string; output?: ToolOutputView; id?: string; command?: string; sub?: SubagentState;
  /** Live rolling tail of a still-running `run_command` (from the `tool_progress` event), shown under the
   *  tool row while it streams. LIVE-only — never persisted; the final `output`/`diff` clears it. */
  progress?: string }

/** Live progress of a delegated sub-agent, attached to its `delegate` tool item by call id — what the
 *  CLI renders as the `↳ …` line under the tool row (current child tool, counters, drill-in target). */
export interface SubagentState {
  sessionId: string;
  status: 'running' | 'done' | 'error';
  task: string;
  detail?: string;
  tools: number;
  tokens?: number;
  seconds: number;
  /** The model the sub-agent runs on (its own, or the delegating conversation's) — shown in the table. */
  model?: string;
}
export type Segment =
  | { kind: 'text'; text: string }
  /** The model's reasoning/thinking stream — rendered dim + separate from the answer. */
  | { kind: 'reasoning'; text: string }
  | { kind: 'tools'; items: ToolItem[] };
/** A rendered tool group: consecutive items of the SAME tool that carry no diff, no output block, no
 *  sub-agent and no console command fold into ONE visual row showing the LAST item's detail plus a
 *  `×count` when >1 (the Claude-Code collapsed look — repeated Read/List/Grep of files). `count` is the
 *  run length; `item` is the newest item in the run so its detail updates in place as calls stream.
 *
 *  Grouping lives in the RENDERER, not the fold: the fold keeps every item separate so the id-keyed
 *  diff/tool_output/subagent attachment (`attachToTool`) still lands on the right item, and resumed
 *  history collapses for free. An item WITH a diff/output/sub/command stays its own group (count 1) —
 *  it renders its own block, and a shell command's verbatim text is meaningful per call. */
export interface ToolGroup { item: ToolItem; count: number }

/** True when an item is a bare tool row (no block of its own), the only kind that collapses. A live
 *  `progress` tail is a block of its own, so a streaming command never folds into a collapsed run. */
function isCollapsibleTool(item: ToolItem): boolean {
  return !item.diff && !item.output && !item.sub && !item.command && !item.progress;
}

/** Fold a tools segment's items into render groups (see {@link ToolGroup}). Pure — recomputed every
 *  render, so a streaming row's count and latest detail stay live. Shared by both CLI renderers. */
export function groupToolItems(items: ToolItem[]): ToolGroup[] {
  const groups: ToolGroup[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && isCollapsibleTool(item) && isCollapsibleTool(last.item) && last.item.name === item.name) {
      groups[groups.length - 1] = { item, count: last.count + 1 }; // latest detail wins, count grows
    } else {
      groups.push({ item, count: 1 });
    }
  }
  return groups;
}

export type YouTurn = { role: 'you'; text: string };
export type ElowenTurn = { role: 'elowen'; segments: Segment[]; streaming: boolean };
/** A context-compaction boundary: everything before it was summarized away, so the surface renders a
 *  subtle "context compacted" divider in its place followed by the kept tail (see `persistCompaction`). */
export type DividerTurn = { role: 'divider' };
export type ChatTurn = YouTurn | ElowenTurn | DividerTurn;

/** The whole view model a surface renders. Pure data — the fold never touches the terminal. `notice`
 *  is a transient runtime line (retry/compaction) cleared when the turn goes idle. */
export interface ChatView { turns: ChatTurn[]; thinking: boolean; notice?: string }

export type ChatViewChange =
  | { kind: 'reset' }
  | { kind: 'append'; index: number }
  | { kind: 'turn'; index: number }
  | { kind: 'none' };

export type AccumulatedChatViewChange =
  | { kind: 'reset' }
  | { kind: 'suffix'; from: number }
  | { kind: 'turns'; indices: number[] }
  | { kind: 'patch'; from: number; indices: number[] }
  | { kind: 'none' };

interface ChatViewChangeNode {
  change: ChatViewChange;
  parent: number | null;
}

interface ChatViewChangeHistory {
  nextRevision: number;
  nodes: Map<number, ChatViewChangeNode>;
}

interface ChatViewChangeRevision {
  history: ChatViewChangeHistory;
  revision: number;
}

// More than a full frame's realistic SSE burst, while still a tiny bounded journal. Nodes contain only
// integers/change descriptors — never ChatView/turn arrays — so the visible snapshot cannot retain its
// immutable predecessors and GC cannot erase metadata before a throttled render consumes it.
const MAX_CHAT_VIEW_CHANGE_NODES = 4_096;
const chatViewChanges = new WeakMap<ChatView, ChatViewChangeRevision>();

function withChange(view: ChatView, change: ChatViewChange, previous?: ChatView): ChatView {
  const prior = previous ? chatViewChanges.get(previous) : undefined;
  const history: ChatViewChangeHistory = prior?.history ?? { nextRevision: 0, nodes: new Map() };
  const revision = history.nextRevision++;
  history.nodes.set(revision, { change, parent: prior?.revision ?? null });
  while (history.nodes.size > MAX_CHAT_VIEW_CHANGE_NODES) {
    const oldest = history.nodes.keys().next().value as number | undefined;
    if (oldest == null) break;
    history.nodes.delete(oldest);
  }
  chatViewChanges.set(view, { history, revision });
  return view;
}

/** Renderer-facing immutable change hint. It stays in a WeakMap so the shared/public ChatView data shape
 * remains unchanged and serialized history never leaks UI bookkeeping. Unknown externally-built views
 * return undefined and renderers fall back to conservative reference reconciliation. */
export function getChatViewChange(view: ChatView): ChatViewChange | undefined;
export function getChatViewChange(view: ChatView, since: ChatView): AccumulatedChatViewChange | undefined;
export function getChatViewChange(view: ChatView, since?: ChatView): ChatViewChange | AccumulatedChatViewChange | undefined {
  const current = chatViewChanges.get(view);
  if (!since) return current ? current.history.nodes.get(current.revision)?.change : undefined;
  if (view === since) return { kind: 'none' };
  const previous = chatViewChanges.get(since);
  if (!current || !previous || current.history !== previous.history) return undefined;

  let cursor = current.revision;
  let suffixFrom = Number.POSITIVE_INFINITY;
  const dirtyTurns = new Set<number>();
  while (cursor !== previous.revision) {
    const node = current.history.nodes.get(cursor);
    if (!node) return undefined; // consumer fell behind the bounded journal
    if (node.change.kind === 'reset') return { kind: 'reset' };
    if (node.change.kind === 'append') {
      suffixFrom = Math.min(suffixFrom, node.change.index);
    } else if (node.change.kind === 'turn') {
      dirtyTurns.add(node.change.index);
    }
    if (node.parent == null) return undefined;
    cursor = node.parent;
  }
  const indices = [...dirtyTurns].filter((index) => index < suffixFrom).sort((a, b) => a - b);
  if (Number.isFinite(suffixFrom)) {
    return indices.length ? { kind: 'patch', from: suffixFrom, indices } : { kind: 'suffix', from: suffixFrom };
  }
  return indices.length ? { kind: 'turns', indices } : { kind: 'none' };
}

/** One stored turn as `fromHistory` consumes it. Structurally the `BrainMessageView` the daemon serves
 *  (`GET /brain/messages`) and the web's `BrainMessage` — a flat `text` plus optional ordered `segments`. */
export interface HistoryMessage {
  role: string;
  text: string;
  segments?: ({ kind: 'text'; text: string } | { kind: 'tool'; name: string; id?: string; detail?: string; diff?: string; output?: ToolOutputView; command?: string; sub?: SubagentState })[];
}

export const emptyView = (): ChatView => withChange({ turns: [], thinking: false }, { kind: 'reset' });

/** Build the initial view from stored history. Assistant turns keep their server-built segments
 *  (ordered text + tool calls with diffs), so a resumed conversation looks exactly like a live one. */
export function fromHistory(msgs: HistoryMessage[]): ChatView {
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
        const item: ToolItem = { name: seg.name, id: seg.id, detail: seg.detail, diff: seg.diff, output: seg.output, command: seg.command, sub: seg.sub };
        const tail = segments[segments.length - 1];
        if (tail?.kind === 'tools') tail.items.push(item);
        else segments.push({ kind: 'tools', items: [item] });
      }
    }
    if (segments.length > 0) turns.push({ role: 'elowen', segments, streaming: false });
  }
  return withChange({ turns, thinking: false }, { kind: 'reset' });
}

/** Append the user's turn (finalized) — called optimistically when they hit enter. */
export function pushUser(view: ChatView, text: string): ChatView {
  return withChange({ ...view, turns: [...view.turns, { role: 'you', text }] }, { kind: 'append', index: view.turns.length }, view);
}

/** Open a fresh streaming assistant turn and switch on the thinking indicator. */
export function beginAssistant(view: ChatView): ChatView {
  return withChange(
    { thinking: true, turns: [...view.turns, { role: 'elowen', segments: [], streaming: true }] },
    { kind: 'append', index: view.turns.length },
    view,
  );
}

/** Fold one brain event into the view. Pure: returns a new ChatView, never mutates the input. Handles
 *  the turn-affecting events (`text`/`reasoning`/`tool`/`diff`/`notice`/`idle`/`error`); a surface routes
 *  the out-of-band events (`card`/`ask`) through `upsertCard` and its own question state instead. */
export function reduce(view: ChatView, e: BrainEvent): ChatView {
  const turns = view.turns.slice();
  // Return a live streaming assistant turn, creating one if the last turn isn't it.
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
      return withChange({ turns, thinking: true, notice: undefined }, { kind: 'turn', index: turns.length - 1 }, view); // first answer text clears any transient notice
    }
    case 'reasoning': {
      addReasoning(ensureElowen(), e.delta);
      return withChange({ turns, thinking: true, notice: view.notice }, { kind: 'turn', index: turns.length - 1 }, view);
    }
    case 'notice': {
      // Transient runtime line (retry/compaction); `done` clears it, otherwise it shows until the next.
      return withChange({ turns, thinking: view.thinking, notice: e.done ? undefined : e.message }, { kind: 'none' }, view);
    }
    case 'tool': {
      const t = ensureElowen();
      const item: ToolItem = { name: e.name, detail: e.detail, icon: e.icon, ...(e.id ? { id: e.id } : {}), ...(e.command ? { command: e.command } : {}) };
      const tail = t.segments[t.segments.length - 1];
      if (tail?.kind === 'tools') t.segments[t.segments.length - 1] = { kind: 'tools', items: [...tail.items, item] };
      else t.segments.push({ kind: 'tools', items: [item] });
      return withChange({ turns, thinking: true, notice: view.notice }, { kind: 'turn', index: turns.length - 1 }, view);
    }
    case 'tool_progress': {
      // Live rolling tail of a running run_command — attach to its in-progress tool row by id so the
      // renderer shows output as it streams. Superseded by the final `tool_output`/`diff` below.
      const t = ensureElowen();
      attachToTool(t, e.id, (item) => ({ ...item, progress: e.text }));
      return withChange({ turns, thinking: true, notice: view.notice }, { kind: 'turn', index: turns.length - 1 }, view);
    }
    case 'diff': {
      // An edit finished — attach its diff to the matching tool when PI gives an id; fall back to the
      // most recent tool for legacy events. A notes-only output view (hook annotations) rides along.
      // The final block supersedes any live `progress` tail (reconcile → no doubled dump).
      const t = ensureElowen();
      attachToTool(t, e.id, ({ progress: _drop, ...item }) => ({ ...item, diff: e.diff, ...(e.output ? { output: e.output } : {}) }));
      return withChange({ turns, thinking: true, notice: view.notice }, { kind: 'turn', index: turns.length - 1 }, view);
    }
    case 'tool_output': {
      const t = ensureElowen();
      // The end event's output has no command (its PI event carries no args) — thread the verbatim
      // command captured on the matching `tool` (start) event so the console block's first line is filled.
      // The final output supersedes any live `progress` tail (reconcile → no doubled dump).
      attachToTool(t, e.id, ({ progress: _drop, ...item }) => ({
        ...item,
        output: item.command && !e.output.command ? { ...e.output, command: item.command } : e.output,
      }));
      return withChange({ turns, thinking: true, notice: view.notice }, { kind: 'turn', index: turns.length - 1 }, view);
    }
    case 'subagent': {
      // A background child may outlive its parent's turn. Search ALL assistant turns backwards by the
      // stable tool-call id and patch that settled row in place; never create a fresh empty/spinning turn.
      // An unknown id is untrusted/stale progress and therefore a true no-op.
      const patched = attachToToolInTurns(turns, e.id, (item) => ({
        ...item,
        sub: { sessionId: e.sessionId, status: e.status, task: e.task, detail: e.detail, tools: e.tools, tokens: e.tokens, seconds: e.seconds, model: e.model },
      }));
      return patched >= 0 ? withChange({ ...view, turns }, { kind: 'turn', index: patched }, view) : view;
    }
    case 'session': {
      // Idle rollover mid-send: the server moved this message into a FRESH conversation. Reset the
      // transcript — the daemon re-emits the triggering message as a `user` event and streams its reply,
      // so the fresh conversation rebuilds purely from the stream. (The daemon is the single authority for
      // the user turn now, so there is no optimistic local 'you' to preserve.)
      return withChange({ turns: [], thinking: view.thinking, notice: view.notice }, { kind: 'reset' }, view);
    }
    case 'user': {
      // The daemon's authoritative render of the user's turn (every real user send — normal or queued
      // delivery — see the `user` BrainEvent). Append the 'you' turn and switch on thinking: a reply is
      // now streaming, and the client no longer echoes optimistically, so this is what shows the bubble.
      return withChange(
        { turns: [...turns, { role: 'you', text: e.text }], thinking: true, notice: view.notice },
        { kind: 'append', index: turns.length },
        view,
      );
    }
    case 'idle': {
      const last = turns[turns.length - 1];
      if (last && last.role === 'elowen') turns[turns.length - 1] = { ...last, streaming: false };
      return withChange({ turns, thinking: false, notice: undefined }, last?.role === 'elowen' ? { kind: 'turn', index: turns.length - 1 } : { kind: 'none' }, view); // turn settled → drop any transient notice
    }
    case 'error': {
      const t = ensureElowen();
      addText(t, `\n[error: ${e.message}]`);
      t.streaming = false;
      return withChange({ turns, thinking: false, notice: undefined }, { kind: 'turn', index: turns.length - 1 }, view);
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

/** Immutable backward lookup across settled + streaming turns, used by background delegate progress.
 *  Tool ids are stable and globally unique enough within one transcript; newest match wins defensively. */
function attachToToolInTurns(turns: ChatTurn[], id: string, patch: (item: ToolItem) => ToolItem): number {
  for (let ti = turns.length - 1; ti >= 0; ti--) {
    const turn = turns[ti]!;
    if (turn.role !== 'elowen') continue;
    for (let si = turn.segments.length - 1; si >= 0; si--) {
      const seg = turn.segments[si]!;
      if (seg.kind !== 'tools') continue;
      const ii = seg.items.findLastIndex((item) => item.id === id);
      if (ii < 0) continue;
      const items = seg.items.slice();
      items[ii] = patch(items[ii]!);
      const segments = turn.segments.slice();
      segments[si] = { kind: 'tools', items };
      turns[ti] = { ...turn, segments };
      return ti;
    }
  }
  return -1;
}

/** Fold a live `card` event into a card list: replace by id, append when new, or drop when the card came
 *  back empty (a cleared panel). Shared by every surface's card region. */
export function upsertCard(cards: BrainCard[], card: BrainCard): BrainCard[] {
  const rest = cards.filter((c) => c.id !== card.id);
  return isEmptyCard(card) ? rest : [...rest, card];
}
