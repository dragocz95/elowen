import type { BrainCard, BrainMessage, BrainMessageFile, BrainMessageImage, BrainPendingPlan, BrainStreamTailEvent, BrainSubagentView, BrainWorkflowView, ToolOutputView } from './types';

/** The workflow DAG a `WorkflowStart` call is running — the shared wire shape (BrainWorkflowView),
 *  attached to its tool item by call id exactly as `sub` is for a delegate call. */
export type WorkflowState = BrainWorkflowView;

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
  | { type: 'tool_authoring'; name?: string; detail?: string; reason?: string }
  | { type: 'tool'; name: string; detail?: string; icon?: string; id?: string; command?: string }
  /** Live rolling tail of a running `Bash` (mirror of the daemon `tool_progress` event). Attaches
   *  to the in-progress tool row by id; the final `tool_output`/`diff` supersedes it (no doubled dump). */
  | { type: 'tool_progress'; id: string; text: string }
  | { type: 'diff'; diff: string; id?: string }
  | { type: 'tool_output'; output: ToolOutputView; id?: string; plan?: string }
  /** A tool that settled with nothing to display. Carried for its `plan`: ExitPlanMode's result text is
   *  addressed to the model and withheld from the transcript, so this is the only live event it has. */
  | { type: 'tool_end'; id?: string; plan?: string }
  /** An image the agent put in front of the user (`ShareImage`, or an image tool's output its reply forgot
   *  to link). The wire carries a `ref` that ALREADY has the `/api` prefix, while the stored segment the
   *  reload rebuilds carries the bare daemon path — {@link imageFromRef} is the single place that
   *  reconciles the two, so live and reloaded produce byte-identical segments. */
  | { type: 'image'; ref: string; id?: string; caption?: string }
  | { type: 'file'; ref: string; name: string; size: number; id?: string; caption?: string }
  | { type: 'notice'; kind: 'retry' | 'compaction'; message: string; done?: boolean }
  | { type: 'session'; sessionId: string }
  | ({ type: 'subagent'; id: string } & BrainSubagentView)
  /** A whole-DAG snapshot of a running `WorkflowStart` call. Attached to its tool row by call id exactly
   *  like `subagent` — attaching (not merely projecting) is what makes it durable, so a reconnect rebuilds
   *  the panel from the transcript instead of losing every workflow it did not witness live. */
  | { type: 'workflow'; id: string; toolCallId: string; title?: string; status: WorkflowState['status']; workspaceRef?: WorkflowState['workspaceRef']; nodes: WorkflowState['nodes'] }
  /** A server-delivered user message (a steered mid-turn message never optimistically echoed) — folded as
   *  a 'you' turn. `durableId` is the store row id, kept on the turn so a later `discard_user` can find it.
   *  The `queue` snapshot event (PI steering queue) is handled outside this fold. */
  | { type: 'user'; text: string; durableId?: string; images?: BrainMessageImage[]; createdAt?: string }
  /** The daemon discarded a just-sent user turn (Esc/Stop before any output): remove the matching 'you'
   *  bubble by `durableId`. Its `text` is restored to the composer by the provider, which owns input state. */
  | { type: 'discard_user'; durableId: string; text: string }
  | { type: 'idle'; model?: string; durationMs?: number; completedAt?: string }
  | { type: 'error'; message: string };

/** An assistant turn is an ordered list of segments so text and tool calls render in the sequence they
 *  happened. Consecutive tool calls (no new text between them) collapse into ONE tools segment → the
 *  Claude-Code "grouped pills" look. Useful tool output previews attach to their matching item. */
export interface ToolItem { name: string; detail?: string; diff?: string; icon?: string; output?: ToolOutputView; id?: string; command?: string; sub?: SubagentState;
  /** The workflow DAG a `WorkflowStart` call is running, attached by its tool call id exactly as `sub` is
   *  for a delegate call. Durable — rebuilt from history on every hydration. */
  wf?: WorkflowState;
  /** The markdown an `ExitPlanMode` call submitted, attached by its tool call id like `sub`/`wf`.
   *  Renders as the plan panel instead of a tool row — a submitted plan is a tool CALL, never a shape
   *  recognized in the model's prose. */
  plan?: string;
  /** Live rolling tail of a still-running `Bash` (from the `tool_progress` event), rendered under
   *  the tool pill while it streams. LIVE-only — never persisted; the final `output`/`diff` clears it. */
  progress?: string }

/** Live progress of a delegated sub-agent, attached to its `delegate` tool item by call id — powers the
 *  agents table + the `↳` drill-in. Mirror of the daemon `SubagentState`. */
export type SubagentState = BrainSubagentView;
type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  /** An image the agent shared on purpose. Its own segment rather than a tool row, because the picture IS
   *  the message — mirror of the wire's `BrainSegment` image variant. */
  | { kind: 'image'; image: BrainMessageImage; caption?: string }
  | { kind: 'file'; file: BrainMessageFile; caption?: string }
  | { kind: 'tools'; items: ToolItem[] };
/** A rendered tool group: consecutive items of the SAME tool with no diff and no output block fold into
 *  ONE pill showing the LAST item's detail plus a `×count` when >1 (mirror of the CLI's
 *  {@link groupToolItems}). Grouping lives in the RENDERER, not the fold, so the id-keyed diff/output
 *  attachment still lands on the right item and resumed history collapses for free. An item WITH a diff
 *  or an output block stays its own group (count 1) and renders its own block. */
export interface ToolGroup { item: ToolItem; count: number;
  /** Every item of a folded run of FAILED tool results. A bare-row run needs only its count (the rows are
   *  identical), but each failure carries its own message — the path it refused — so the renderer keeps
   *  them all to list on expand. */
  members?: ToolItem[] }

function isCollapsibleTool(item: ToolItem): boolean {
  return !item.diff && !item.output && !item.sub && !item.wf && !item.command && !item.progress && !item.plan;
}

/** The kind of failure a tool result is, or undefined when it is not one. Four refusals that differ only
 *  by the file they name are ONE failure repeated — so the signature is the message with its varying parts
 *  (paths and numbers) flattened away, under the tool that produced it. Only `result` outputs fold; a
 *  console command's output is the thing you want to read when it fails, and differs every time. MUST stay
 *  in lockstep with the daemon `failureSignature` (src/brain/transcript.ts) — the conformance test guards it. */
export function failureSignature(item: ToolItem): string | undefined {
  const output = item.output;
  if (!output || output.kind !== 'result') return undefined;
  if (output.tone !== 'warning' && output.tone !== 'danger') return undefined;
  const firstLine = (output.text ?? '').split('\n').find((line) => line.trim()) ?? '';
  const shape = firstLine.replace(/\S*\/\S+/g, '§').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 160);
  return `${item.name}|${shape}`;
}

/** Fold a tools segment's items into render groups (see {@link ToolGroup}). Pure — recomputed every
 *  render so a streaming pill's count and latest detail stay live. Mirror of the daemon `groupToolItems`
 *  (src/brain/transcript.ts); the conformance test asserts the two stay identical. */
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
      groups[groups.length - 1] = { item, count: last.count + 1, members: [...(last.members ?? [last.item]), item] };
      continue;
    }
    groups.push({ item, count: 1 });
  }
  return groups;
}

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
};

/** Turn the wire `image` event's `ref` into the SAME {@link BrainMessageImage} a stored image segment
 *  carries, so the renderer has one shape to draw and one prefix rule to apply. The event's ref is a
 *  browser-facing path (`/api/brain/chat-images/x.png`, or the older `/api/brain/images/x.png`) while a
 *  stored segment holds the bare daemon path — strip the prefix here rather than teaching the renderer
 *  that a live image is addressed differently from a reloaded one. The mime type is not on the wire, so
 *  it is read off the extension the daemon constrains to png/jpg/gif/webp. */
function imageFromRef(ref: string): BrainMessageImage {
  const url = ref.startsWith('/api/') ? ref.slice('/api'.length) : ref;
  const extension = url.slice(url.lastIndexOf('.') + 1).toLowerCase();
  return { url, mimeType: IMAGE_MIME_BY_EXTENSION[extension] ?? 'application/octet-stream' };
}

/** `id` is the source store row's UUID — present on every turn built from stored history (`fromHistory`),
 *  absent on turns synthesized live by `reduce` (a streaming reply, a steered user message). It is a
 *  STABLE React key (so a lazy-load prepend never remounts the live tail) and the identity `prependHistory`
 *  dedupes on — never a text fingerprint. */
type YouTurn = { role: 'you'; text: string; id?: string; images?: BrainMessageImage[]; createdAt?: string };
type ElowenTurn = {
  role: 'elowen'; segments: Segment[]; streaming: boolean; id?: string; synthetic?: boolean; createdAt?: string; durationMs?: number; model?: string;
  /** Live-only tool-call authoring hint. Cleared as soon as the matching tool starts or the turn settles. */
  composing?: boolean; composingTool?: string; composingDetail?: string; composingReason?: string;
};
/** A context-compaction boundary: everything before it was summarized away server-side, so the dock
 *  renders a subtle "context compacted" divider in its place, followed by the kept tail. */
type DividerTurn = { role: 'divider'; id?: string };
/** One visible marker of an owner session-state change (model/mode/rename/cwd). Mirror of the daemon
 *  `SessionEventItem`; `id` dedups a live marker against the same durable one seeded from history. */
export interface SessionEventItem { id: string; kind: string; detail: string }
/** A run of session-change markers interleaved into the transcript by time. Display-only. Consecutive
 *  markers collapse into ONE turn (as consecutive tool calls collapse into one segment). */
type EventTurn = { role: 'event'; events: SessionEventItem[]; id?: string };
export type ChatTurn = YouTurn | ElowenTurn | DividerTurn | EventTurn;

/** The whole view model the dock renders. `notice` is a transient runtime line (retry/compaction). */
export interface ChatView { turns: ChatTurn[]; thinking: boolean; notice?: string }

export const emptyView = (): ChatView => ({ turns: [], thinking: false });

/** Build the initial view from stored history (`GET /brain/messages`). Server-built segments preserve
 *  the true text/tool order; older rows fall back to a single flat text segment. */
export function fromHistory(msgs: BrainMessage[]): ChatView {
  const turns: ChatTurn[] = [];
  for (const m of msgs) {
    // A compaction boundary → a divider turn (the pre-compaction history was summarized away).
    if (m.role === 'compaction') { turns.push({ role: 'divider', id: m.id }); continue; }
    // A session-change marker (model/mode/rename/cwd) → an event turn; consecutive markers collapse.
    if (m.role === 'event') {
      const item: SessionEventItem = { id: m.id ?? '', kind: m.kind ?? '', detail: m.detail ?? '' };
      const tail = turns[turns.length - 1];
      if (tail?.role === 'event') tail.events.push(item);
      else turns.push({ role: 'event', events: [item], id: m.id });
      continue;
    }
    if (m.role === 'user') {
      // An attachment-only message has no text left once the daemon drops the `[📎 …]` marker for a client
      // that draws the thumbnails, so the images alone are enough to keep the bubble.
      if (m.text.trim() || m.images?.length) turns.push({
        role: 'you', text: m.text, id: m.id,
        ...(m.images?.length ? { images: m.images } : {}),
        ...(m.createdAt ? { createdAt: m.createdAt } : {}),
      });
      continue;
    }
    const segments: Segment[] = [];
    for (const seg of m.segments ?? (m.text.trim() ? [{ kind: 'text' as const, text: m.text }] : [])) {
      if (seg.kind === 'text') {
        segments.push({ kind: 'text', text: seg.text });
      } else if (seg.kind === 'image') {
        segments.push({ kind: 'image', image: seg.image, ...(seg.caption ? { caption: seg.caption } : {}) });
      } else if (seg.kind === 'file') {
        segments.push({ kind: 'file', file: seg.file, ...(seg.caption ? { caption: seg.caption } : {}) });
      } else {
        const item: ToolItem = { name: seg.name, id: seg.id, detail: seg.detail, diff: seg.diff, output: seg.output, command: seg.command, sub: seg.sub, wf: seg.wf, plan: seg.plan };
        const tail = segments[segments.length - 1];
        if (tail?.kind === 'tools') tail.items.push(item);
        else segments.push({ kind: 'tools', items: [item] });
      }
    }
    if (segments.length > 0) turns.push({
      role: 'elowen', segments, streaming: false, id: m.id,
      ...(m.synthetic ? { synthetic: true } : {}),
      ...(m.createdAt ? { createdAt: m.createdAt } : {}),
      ...(m.durationMs != null ? { durationMs: m.durationMs } : {}),
      ...(m.model ? { model: m.model } : {}),
    });
  }
  return { turns, thinking: false };
}

/** Mirror of the daemon's typed anchor rules: Delegate and DelegateContinue share one sub-agent anchor
 *  class, while a workflow belongs only to WorkflowStart. A foreign tool reusing an id must never evict a
 *  synthetic anchor or receive a live sidecar update. */
function isSubagentToolName(name: string): boolean {
  return name === 'Delegate' || name === 'DelegateContinue';
}

function runningAnchorKeys(turn: ChatTurn): string[] {
  if (turn.role !== 'elowen') return [];
  return turn.segments.flatMap((segment) => segment.kind === 'tools'
    ? segment.items.flatMap((item) => {
        if (!item.id) return [];
        if (isSubagentToolName(item.name)) return [`subagent:${item.id}`];
        if (item.name === 'WorkflowStart') return [`workflow:${item.id}`];
        return [];
      })
    : []);
}

/** Prepend an older page of stored history (chat lazy-load, scroll-up) in front of the current view. Turns
 *  already present are dropped by `id` so a re-fetched or overlapping page can't double a turn; the live
 *  streaming tail is never touched (older turns only ever go in front).
 *
 *  First-page snapshots may contain synthetic Delegate/WorkflowStart anchors for running work whose real
 *  tool row sits on an older page. When pagination reaches that row, replace the synthetic turn by tool-call
 *  id before prepending it. Otherwise both copies survive (their message ids differ), and a later terminal
 *  event patches only one of them, leaving a phantom running row in the panel. */
export function prependHistory(view: ChatView, older: BrainMessage[]): ChatView {
  const incoming = fromHistory(older).turns;
  const realAnchorKeys = new Set(incoming.flatMap((turn) => turn.role === 'elowen' && !turn.synthetic ? runningAnchorKeys(turn) : []));
  const withoutReplaced = realAnchorKeys.size === 0
    ? view.turns
    : view.turns.filter((turn) => !(turn.role === 'elowen' && turn.synthetic
      && runningAnchorKeys(turn).some((key) => realAnchorKeys.has(key))));
  const retained = withoutReplaced.length === view.turns.length ? view.turns : withoutReplaced;

  const known = new Set<string>();
  for (const turn of retained) if (turn.id) known.add(turn.id);
  const prepend = incoming.filter((turn) => !turn.id || !known.has(turn.id));
  if (prepend.length === 0 && retained === view.turns) return view;
  return { ...view, turns: [...prepend, ...retained] };
}

/** The event types {@link reduce} folds. A stream snapshot replays the WHOLE live tail, which also carries
 *  out-of-band frames (card / ask / queue / step) the transcript fold has no case for — this narrows the
 *  wire events down to the ones it understands instead of casting the rest through it. */
const TRANSCRIPT_EVENT_TYPES = new Set<TranscriptEvent['type']>([
  'text', 'reasoning', 'tool_authoring', 'tool', 'tool_progress', 'diff', 'tool_output', 'tool_end', 'image',
  'notice', 'session', 'subagent', 'workflow', 'user', 'discard_user', 'idle', 'error',
]);

function isTranscriptEvent(event: BrainStreamTailEvent): event is BrainStreamTailEvent & TranscriptEvent {
  return TRANSCRIPT_EVENT_TYPES.has(event.type as TranscriptEvent['type']);
}

/** Rebuild the entire view from a stream snapshot frame: the durable history plus the current run's
 *  not-yet-durable tail, folded in order. REPLACES the view — it is never merged into what is already
 *  rendered, because the server withholds from `history` exactly those user rows it replays as ordering
 *  markers in `events`. Merging (or pairing this with a separate history fetch) doubles those bubbles. */
export function fromSnapshot(snapshot: { history: BrainMessage[]; events: BrainStreamTailEvent[] }): ChatView {
  let view = fromHistory(snapshot.history);
  for (const event of snapshot.events) if (isTranscriptEvent(event)) view = reduce(view, event);
  return view;
}

/** Fold one brain event into the view. Pure: returns a new ChatView, never mutates the input. */
export function reduce(view: ChatView, e: TranscriptEvent): ChatView {
  const turns = view.turns.slice();
  const ensureElowen = (): ElowenTurn => {
    const last = turns[turns.length - 1];
    if (last && last.role === 'elowen' && last.streaming) {
      const clone: ElowenTurn = {
        role: 'elowen', segments: [...last.segments], streaming: true,
        composing: last.composing, composingTool: last.composingTool,
        composingDetail: last.composingDetail, composingReason: last.composingReason,
      };
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
    case 'tool_authoring': {
      const t = ensureElowen();
      if (t.composing && t.composingTool === e.name && t.composingDetail === e.detail && t.composingReason === e.reason) return view;
      t.composing = true;
      t.composingTool = e.name;
      t.composingDetail = e.detail;
      t.composingReason = e.reason;
      return { turns, thinking: true, notice: view.notice };
    }
    case 'tool': {
      const t = ensureElowen();
      t.composing = false;
      t.composingTool = undefined;
      t.composingDetail = undefined;
      t.composingReason = undefined;
      const item: ToolItem = { name: e.name, detail: e.detail, icon: e.icon, ...(e.id ? { id: e.id } : {}), ...(e.command ? { command: e.command } : {}) };
      const tail = t.segments[t.segments.length - 1];
      if (tail?.kind === 'tools') t.segments[t.segments.length - 1] = { kind: 'tools', items: [...tail.items, item] };
      else t.segments.push({ kind: 'tools', items: [item] });
      return { turns, thinking: true, notice: view.notice };
    }
    case 'tool_progress': {
      // Live rolling tail of a running Bash — attach to its in-progress tool pill by id so the
      // dock shows output as it streams. Superseded by the final `tool_output`/`diff` below.
      const t = ensureElowen();
      attachToTool(t, e.id, (item) => ({ ...item, progress: e.text }));
      return { turns, thinking: true, notice: view.notice };
    }
    case 'diff': {
      // The final block supersedes any live `progress` tail (reconcile → no doubled dump).
      const t = ensureElowen();
      attachToTool(t, e.id, ({ progress: _drop, ...item }) => ({ ...item, diff: e.diff }));
      return { turns, thinking: true, notice: view.notice };
    }
    case 'tool_output': {
      // The final output supersedes any live `progress` tail (reconcile → no doubled dump).
      const t = ensureElowen();
      attachToTool(t, e.id, ({ progress: _drop, ...item }) => ({ ...item, output: e.output, ...(e.plan ? { plan: e.plan } : {}) }));
      return { turns, thinking: true, notice: view.notice };
    }
    case 'tool_end': {
      if (!e.plan) return view;
      attachToTool(ensureElowen(), e.id, (item) => ({ ...item, plan: e.plan }));
      return { turns, thinking: true, notice: view.notice };
    }
    case 'image': {
      // A shared image is its own segment, never merged into a neighbour: two pictures in a row are two
      // pictures, and a caption belongs to exactly one of them.
      const t = ensureElowen();
      t.segments.push({ kind: 'image', image: imageFromRef(e.ref), ...(e.caption ? { caption: e.caption } : {}) });
      return { turns, thinking: true, notice: view.notice };
    }
    case 'file': {
      const t = ensureElowen();
      t.segments.push({ kind: 'file', file: { url: e.ref.startsWith('/api/') ? e.ref.slice(4) : e.ref, name: e.name, size: e.size }, ...(e.caption ? { caption: e.caption } : {}) });
      return { turns, thinking: true, notice: view.notice };
    }
    case 'subagent': {
      // Background children can finish after the parent assistant turn is already settled. Patch that
      // historical delegate row by id; do not fabricate an empty streaming turn or re-enable thinking.
      const { type: _type, id, ...sub } = e;
      const patched = attachToToolInTurns(turns, id, isSubagentToolName, (item) => ({ ...item, sub }));
      return patched ? { ...view, turns } : view;
    }
    case 'workflow': {
      // Like `subagent`: a background workflow can report after the parent turn settled, so patch the
      // existing WorkflowStart row by call id rather than opening a streaming turn for it.
      const wf: WorkflowState = {
        id: e.id, toolCallId: e.toolCallId, status: e.status, nodes: e.nodes,
        ...(e.title ? { title: e.title } : {}),
        ...(e.workspaceRef ? { workspaceRef: e.workspaceRef } : {}),
      };
      const patched = attachToToolInTurns(turns, e.toolCallId, (name) => name === 'WorkflowStart', (item) => ({ ...item, wf }));
      return patched ? { ...view, turns } : view;
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
      // Keep the durable id on the turn so an Esc/Stop-before-output `discard_user` can pull this bubble.
      return {
        turns: [...turns, {
          role: 'you',
          text: e.text,
          ...(e.durableId ? { id: e.durableId } : {}),
          // Same references and timestamp the reload path will serve, so the bubble does not change on
          // refresh — the daemon reads both back off the durable row it just wrote.
          ...(e.images?.length ? { images: e.images } : {}),
          ...(e.createdAt ? { createdAt: e.createdAt } : {}),
        }],
        thinking: true,
        notice: view.notice,
      };
    }
    case 'discard_user': {
      // The daemon cancelled this user turn before it produced output: drop the matching 'you' bubble and
      // stop the spinner. The composer restore is the provider's job (it owns the input state).
      const index = turns.findIndex((turn) => turn.role === 'you' && turn.id === e.durableId);
      // No match — a duplicate discard (double Esc) or a turn already gone. Leave the view untouched:
      // forcing thinking:false here would kill the spinner of a turn the user has meanwhile resent.
      if (index === -1) return view;
      turns.splice(index, 1);
      return { turns, thinking: false, notice: undefined };
    }
    case 'idle': {
      const last = turns[turns.length - 1];
      if (last && last.role === 'elowen') turns[turns.length - 1] = {
        ...last, streaming: false,
        composing: false, composingTool: undefined, composingDetail: undefined, composingReason: undefined,
        ...(e.completedAt ? { createdAt: e.completedAt } : {}),
        ...(e.durationMs != null ? { durationMs: e.durationMs } : {}),
        ...(e.model ? { model: e.model } : {}),
      };
      return { turns, thinking: false, notice: undefined };
    }
    case 'error': {
      const t = ensureElowen();
      addText(t, `\n[error: ${e.message}]`);
      t.streaming = false;
      t.composing = false;
      t.composingTool = undefined;
      t.composingDetail = undefined;
      t.composingReason = undefined;
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

function attachToToolInTurns(
  turns: ChatTurn[],
  id: string,
  acceptsName: (name: string) => boolean,
  patch: (item: ToolItem) => ToolItem,
): boolean {
  for (let ti = turns.length - 1; ti >= 0; ti--) {
    const turn = turns[ti]!;
    if (turn.role !== 'elowen') continue;
    for (let si = turn.segments.length - 1; si >= 0; si--) {
      const seg = turn.segments[si]!;
      if (seg.kind !== 'tools') continue;
      const ii = seg.items.findLastIndex((item) => item.id === id && acceptsName(item.name));
      if (ii < 0) continue;
      const items = seg.items.slice();
      items[ii] = patch(items[ii]!);
      const segments = turn.segments.slice();
      segments[si] = { kind: 'tools', items };
      turns[ti] = { ...turn, segments };
      return true;
    }
  }
  return false;
}

/** Collect the delegated sub-agents across the whole transcript (one per child session, latest state
 *  wins) — the source for the agents table + drill-in. Mirrors the CLI's `subagentStates()` scan. */
export function collectSubagents(turns: ChatTurn[]): SubagentState[] {
  const byId = new Map<string, SubagentState>();
  for (const turn of turns) {
    if (turn.role !== 'elowen') continue;
    for (const seg of turn.segments) {
      if (seg.kind !== 'tools') continue;
      for (const item of seg.items) if (item.sub?.sessionId) byId.set(item.sub.sessionId, item.sub);
    }
  }
  return [...byId.values()];
}

/** Collect the workflows across the whole transcript (one per workflow id, latest state wins) — the
 *  source for the rail's workflow section. Mirrors the CLI's `TranscriptModel.workflows()` projection. */
export function collectWorkflows(turns: ChatTurn[]): WorkflowState[] {
  const byId = new Map<string, WorkflowState>();
  for (const turn of turns) {
    if (turn.role !== 'elowen') continue;
    for (const seg of turn.segments) {
      if (seg.kind !== 'tools') continue;
      for (const item of seg.items) if (item.wf) byId.set(item.wf.id, item.wf);
    }
  }
  return [...byId.values()];
}

/** The plan an `ExitPlanMode` call submitted in the newest assistant turn, with the id of the call that
 *  submitted it — the transcript's own answer to "is a plan waiting on the user", live from `tool_end`
 *  and rebuilt from history on every hydration. Mirror of the CLI's `TranscriptModel.lastSubmittedPlan`.
 *
 *  Trailing non-assistant turns are SKIPPED rather than disqualifying: a session-event marker or a
 *  compaction divider landing after the plan (the user switching model or mode in that window) is not the
 *  conversation moving on, and treating it as such is what made the decision disappear. A newer 'you' turn
 *  or a later assistant turn without a plan still answers null, so nothing resurrects. */
export function submittedPlan(turns: ChatTurn[]): BrainPendingPlan | null {
  const last = turns.findLast((turn) => turn.role !== 'event' && turn.role !== 'divider');
  if (last?.role !== 'elowen') return null;
  let found: BrainPendingPlan | null = null;
  for (const seg of last.segments) {
    if (seg.kind !== 'tools') continue;
    for (const item of seg.items) if (item.plan) found = { ...(item.id ? { id: item.id } : {}), plan: item.plan };
  }
  return found;
}

/** How much of the assistant's current prose {@link liveNarration} hands to a plugin surface. A narration
 *  is a glance, not a transcript: three lines of it is what an overlay can show, and the cap is what keeps
 *  a long reply from growing the string (and the re-render it causes) without bound as it streams. */
export const NARRATION_MAX_CHARS = 240;

/** The assistant prose a user can read RIGHT NOW, for a surface that covers the transcript (a plugin
 *  artifact expanded over the dock). It is a projection of what the dock already renders — the same
 *  segment strings, never a second composition — reduced to the one thing such a surface can carry.
 *
 *  Only `text` segments, and only from the newest assistant turn: reasoning is hidden content the reader
 *  has not asked to see, a tool row is not prose, and a turn that has scrolled past is not what is being
 *  said now. A newer `you` turn answers empty rather than the previous reply, so a covering surface can
 *  never show text from a question the user has already moved on from; session switches clear the turns
 *  themselves, so nothing survives one. Trailing event/divider turns are skipped exactly as
 *  {@link submittedPlan} skips them — a model switch mid-reply is not the conversation moving on.
 *
 *  The LAST text segment wins: prose, a tool call, then more prose is the model talking again, and the
 *  newest sentence is the one that describes what is happening. Whitespace is collapsed so the cap counts
 *  what a reader sees, and an over-long narration keeps its TAIL (from the next word boundary) because
 *  the end of a streaming sentence is the live part. */
export function liveNarration(turns: ChatTurn[]): string {
  const last = turns.findLast((turn) => turn.role !== 'event' && turn.role !== 'divider');
  if (last?.role !== 'elowen') return '';
  const spoken = last.segments.findLast((segment) => segment.kind === 'text' && segment.text.trim() !== '');
  if (!spoken || spoken.kind !== 'text') return '';
  const text = spoken.text.replace(/\s+/g, ' ').trim();
  if (text.length <= NARRATION_MAX_CHARS) return text;
  const tail = text.slice(text.length - NARRATION_MAX_CHARS);
  const space = tail.indexOf(' ');
  // One unbroken token longer than the cap (a URL, a base64 blob) has no boundary to cut at: keep it whole
  // rather than returning nothing.
  return space < 0 ? tail : tail.slice(space + 1).trim();
}

/** Fold a live `card` event into the card list: replace by id, append when new, drop when it came back
 *  empty (a cleared panel). Mirrors the daemon `isEmptyCard`: a card with neither items nor body removes. */
export function upsertCard(cards: BrainCard[], card: BrainCard): BrainCard[] {
  const rest = cards.filter((c) => c.id !== card.id);
  const empty = (!card.items || card.items.length === 0) && !card.body;
  return empty ? rest : [...rest, card];
}
