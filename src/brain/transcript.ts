import type { BrainCard, WorkflowUpdate } from './events.js';
import { isEmptyCard } from './cards.js';
import type { ToolOutputView } from './messageView.js';

/** The CLI/web projection of a live `workflow` snapshot — structurally the event payload itself (a
 *  workflow event carries the WHOLE DAG each time), so it aliases WorkflowUpdate to stay single-source
 *  with the wire contract. `TranscriptModel.workflows()` keeps the latest one per id. */
export type WorkflowState = WorkflowUpdate;
export type { WorkflowNode } from './events.js';

/** Shared, UI-free transcript data types and durable-history parsing. `TranscriptModel` owns the live
 *  event fold for the CLI; the web dock mirrors the same wire contract in
 *  `web/lib/transcript.ts` (a separate browser bundle can't import daemon NodeNext source — see that
 *  file's note). Pure data: nothing here touches a terminal, React or Discord.
 *
 *  An assistant turn is an ordered list of segments so text and tool calls render in the sequence they
 *  happened. Consecutive tool calls (no new text between them) collapse into ONE tools segment — the
 *  Claude-Code "grouped" look. Tool outputs are attached only when the daemon marks a compact preview
 *  as useful enough to show (tests, shell errors, browser/search observations). */
export interface ToolItem { name: string; detail?: string; diff?: string; icon?: string; output?: ToolOutputView; id?: string; command?: string; sub?: SubagentState;
  /** The workflow DAG a `WorkflowStart` call is running, attached by its tool call id exactly as `sub`
   *  is for a delegate call. Durable: this is what the panel projection is rebuilt from on every
   *  hydration, so it is also what lets a finished workflow still open its modal from the transcript. */
  wf?: WorkflowState;
  /** Live rolling tail of a still-running `Bash` (from the `tool_progress` event), shown under the
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
  /** The sub-agent's own effective reasoning effort (level id + display label), for the child status bar. */
  thinkingLevel?: string;
  thinkingLabel?: string;
  /** True once the user detached this job from the parent tool wait with Ctrl+B. */
  background?: boolean;
  autoDeliver?: boolean;
  resultDelivery?: 'pending' | 'acknowledged';
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
 *  Grouping lives in the RENDERER, not the model: the model keeps every item separate so id-keyed
 *  diff/tool_output/subagent attachment still lands on the right item, and resumed
 *  history collapses for free. An item WITH a diff/output/sub/command stays its own group (count 1) —
 *  it renders its own block, and a shell command's verbatim text is meaningful per call. */
export interface ToolGroup {
  item: ToolItem;
  count: number;
  /** Every item of a folded run of FAILED tool results. A bare-row run needs only its count (the rows are
   *  identical), but each failure carries its own message — the path it refused — so the renderer keeps
   *  them all to list on expand. */
  members?: ToolItem[];
}

/** True when an item is a bare tool row (no block of its own), the only kind that collapses. A live
 *  `progress` tail is a block of its own, so a streaming command never folds into a collapsed run. */
function isCollapsibleTool(item: ToolItem): boolean {
  return !item.diff && !item.output && !item.sub && !item.wf && !item.command && !item.progress;
}

/** The kind of failure a tool result is, or undefined when it is not one. Four refusals that differ only
 *  by the file they name are ONE failure repeated, and reading them as such is what lets the transcript
 *  show a single row instead of four identical blocks. So the signature is the message with its varying
 *  parts — paths and numbers — flattened away, under the tool that produced it.
 *
 *  Only `result` outputs fold. A console command's output is the thing you actually want to read when it
 *  fails (the failing test, the stack trace), and it is different every time; collapsing that would hide
 *  the one output worth showing. */
export function failureSignature(item: ToolItem): string | undefined {
  const output = item.output;
  if (!output || output.kind !== 'result') return undefined;
  if (output.tone !== 'warning' && output.tone !== 'danger') return undefined;
  const firstLine = (output.text ?? '').split('\n').find((line) => line.trim()) ?? '';
  const shape = firstLine.replace(/\S*\/\S+/g, '§').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 160);
  return `${item.name}|${shape}`;
}

/** Fold a tools segment's items into render groups (see {@link ToolGroup}). Pure — recomputed every
 *  render, so a streaming row's count and latest detail stay live. Shared by both CLI renderers. */
export function groupToolItems(items: ToolItem[]): ToolGroup[] {
  const groups: ToolGroup[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && isCollapsibleTool(item) && isCollapsibleTool(last.item) && last.item.name === item.name) {
      groups[groups.length - 1] = { item, count: last.count + 1 }; // latest detail wins, count grows
      continue;
    }
    const signature = failureSignature(item);
    if (signature && last && signature === failureSignature(last.item)) {
      groups[groups.length - 1] = {
        item,
        count: last.count + 1,
        members: [...(last.members ?? [last.item]), item],
      };
      continue;
    }
    groups.push({ item, count: 1 });
  }
  return groups;
}

export type YouTurn = { role: 'you'; text: string };
export type ElowenTurn = { role: 'elowen'; segments: Segment[]; streaming: boolean;
  /** True while the model is writing a tool call whose marker has not yet rendered — a live-only hint set
   *  by `tool_authoring` and cleared by the first `tool` of the turn. Never persisted (history turns are
   *  never streaming). */
  composing?: boolean };
/** A context-compaction boundary: everything before it was summarized away, so the surface renders a
 *  subtle "context compacted" divider in its place followed by the kept tail (see `persistCompaction`). */
export type DividerTurn = { role: 'divider' };
/** One visible marker of an owner session-state change. `id` dedups a live-folded event against the same
 *  durable marker already seeded from history. */
export interface SessionEventItem { id: string; kind: string; detail: string }
/** A run of session-change markers, interleaved into the transcript by time. Display-only — never part of
 *  the model's context. Consecutive markers (switching model AND mode before speaking again) collapse into
 *  ONE turn holding them all, exactly as consecutive tool calls collapse into one segment: they then stack
 *  as a block, and the single blank every turn ends with separates the block from what follows instead of
 *  falling between each pair. */
export type EventTurn = { role: 'event'; events: SessionEventItem[] };
export type ChatTurn = YouTurn | ElowenTurn | DividerTurn | EventTurn;

/** One stored turn as `turnsFromHistory` consumes it. Structurally the `BrainMessageView` the daemon serves
 *  (`GET /brain/messages`) and the web's `BrainMessage` — a flat `text` plus optional ordered `segments`. */
export interface HistoryMessage {
  role: string;
  text: string;
  segments?: ({ kind: 'text'; text: string } | { kind: 'tool'; name: string; id?: string; detail?: string; diff?: string; output?: ToolOutputView; command?: string; sub?: SubagentState; wf?: WorkflowState })[];
  /** The source's own id: the store row's for a `user`/`assistant`/`compaction` row, the session-change
   *  marker's for a `role:'event'` row. Absent only when the source had none. */
  id?: string;
  /** Present only on a `role:'event'` row — the session-change marker's kind/detail. */
  kind?: string;
  detail?: string;
}

/** Parse the durable wire/storage transcript into render turns without adding runtime bookkeeping. */
export function turnsFromHistory(msgs: HistoryMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const m of msgs) {
    if (m.role === 'compaction') { turns.push({ role: 'divider' }); continue; }
    if (m.role === 'event') {
      const item: SessionEventItem = { id: m.id ?? '', kind: m.kind ?? '', detail: m.detail ?? '' };
      const tail = turns[turns.length - 1];
      if (tail?.role === 'event') tail.events.push(item);
      else turns.push({ role: 'event', events: [item] });
      continue;
    }
    if (m.role === 'user') {
      if (m.text.trim()) turns.push({ role: 'you', text: m.text });
      continue;
    }
    const segments: Segment[] = [];
    for (const seg of m.segments ?? (m.text.trim() ? [{ kind: 'text' as const, text: m.text }] : [])) {
      if (seg.kind === 'text') {
        segments.push({ kind: 'text', text: seg.text });
      } else {
        const item: ToolItem = { name: seg.name, id: seg.id, detail: seg.detail, diff: seg.diff, output: seg.output, command: seg.command, sub: seg.sub, wf: seg.wf };
        const tail = segments[segments.length - 1];
        if (tail?.kind === 'tools') tail.items.push(item);
        else segments.push({ kind: 'tools', items: [item] });
      }
    }
    if (segments.length > 0) turns.push({ role: 'elowen', segments, streaming: false });
  }
  return turns;
}

/** Fold a live `card` event into a card list: replace by id, append when new, or drop when the card came
 *  back empty (a cleared panel). Shared by every surface's card region. */
export function upsertCard(cards: BrainCard[], card: BrainCard): BrainCard[] {
  const rest = cards.filter((c) => c.id !== card.id);
  return isEmptyCard(card) ? rest : [...rest, card];
}
