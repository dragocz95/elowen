import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { isContextOverflow } from '@earendil-works/pi-ai';
import { submittedPlan, toolCommand, toolDetail, toolDisplay, toolOutputView } from './messageView.js';
import type { ToolOutputView } from './messageView.js';
import type { AskQuestion, BrainUsage, BrainGoalState, BrainMessageImage } from '../shared/wireContract.js';
import type { ProcessInfo } from './processRegistry.js';
import { extractReason } from './toolReason.js';
import { collapseWhitespace } from '../shared/text.js';

// The usage and goal shapes are the daemon↔web wire contract (idle/status events + the snapshot
// frame's `goal`) — defined once in src/shared and re-exported here, so the two can never drift.
export type { BrainUsage, BrainGoalState };

/** What a channel (web/terminal/Discord) receives from the brain. Stable regardless of the underlying
 *  PI event shape — the mapping lives in one place (`toBrainEvent`). This is the wire contract every
 *  chat client folds: `text`, `idle` and `error` are the minimum a client must handle; everything else
 *  may be ignored. The shared reducer (`src/brain/transcript.ts`) is the reference implementation. */
export type BrainEvent =
  | { type: 'text'; delta: string }
  /** The model's reasoning/thinking stream (extended-thinking models) — shown as a dim, separate
   *  segment. Surfaced from PI's `thinking_delta`; channels may choose to ignore it. */
  | { type: 'reasoning'; delta: string }
  /** The model has begun WRITING a tool call — its arguments are streaming, before the call executes.
   *  Bridges the gap where the transcript would otherwise freeze (text done, tool marker not yet shown);
   *  the matching `tool` event, which renders the marker, ends it. Purely a live hint: no durable row, and
   *  a client may ignore it. Authoring is atomic per turn (PI writes every call, then executes), so this
   *  needs no id — the first `tool` of the turn clears it. `detail` is the call's salient argument as it
   *  streams in (file path, command, query…), so a long-duration tool can show a localized action label
   *  instead of the generic hint; absent until the arguments have streamed far enough to derive one.
   *  `reason` is the model-authored status note (the tool's leading `reason` arg) as it streams — when
   *  present it supersedes the localized label; the CLI shows it verbatim next to the spinner. */
  | { type: 'tool_authoring'; name?: string; detail?: string; reason?: string }
  /** A tool call starting. `icon` is resolved daemon-side from the core map + plugin manifest `icons`
   *  (single source; clients render it, falling back to a generic glyph when absent). */
  | { type: 'tool'; name: string; detail?: string; icon?: string; id?: string; command?: string }
  /** An edit finished. `output`, when present, is a minimal notes-only view (hook annotations like
   *  "formatted a.ts with prettier" — see `details.notes`) the reducer attaches alongside the diff;
   *  clients that ignore it lose only the note, never the diff. */
  | { type: 'diff'; diff: string; id?: string; output?: ToolOutputView }
  | { type: 'tool_output'; output: ToolOutputView; id?: string; plan?: string }
  /** A tool completed without a displayable output block. This closes status-only renderers (Discord)
   *  while transcript clients may safely ignore it; output/diff events already imply completion.
   *
   *  `plan` is the markdown a settled `ExitPlanMode` call submitted — the live twin of the durable
   *  `BrainSegment.plan`, so the plan panel and the "implement it?" decision are driven by the CALL on
   *  the live path too, not only after a history refetch. It rides both settle events because a
   *  hook-annotated result would take the `tool_output` branch instead. */
  | { type: 'tool_end'; id?: string; isError?: boolean; plan?: string }
  /** A structured display card a plugin pushed via `ctx.emitCard` — a live panel (CLI above the status
   *  bar, Discord in the streamed message, web in a cards region) keyed by `card.id` so a re-emit
   *  replaces it; an empty card (no items/body) removes it. Generalizes what the todo checklist used to
   *  do with its own bespoke event. */
  | { type: 'card'; card: BrainCard }
  /** Live streamed output of an IN-PROGRESS `Bash` foreground run — and ONLY that tool, so every
   *  other tool stays silent (no `_update` re-noise flooding the SSE). Mapped from PI's
   *  `tool_execution_update`, THROTTLED to at most one per `PROGRESS_THROTTLE_MS` per tool call, and
   *  carrying a bounded rolling TAIL of the output so far (never the whole buffer). Keyed by `id`
   *  (the `toolCallId`): the reducer renders it under the matching in-progress tool row, and the final
   *  `tool_output`/`diff` for that id SUPERSEDES it — so a long build streams live without ever doubling
   *  its dump. Safe to ignore (the final output still arrives). */
  | { type: 'tool_progress'; id: string; text: string }
  /** A stored image to put in front of the user: one the agent shared on purpose (`ShareImage`, which
   *  also carries a `caption`), or one an image tool produced and the model's final text forgot to link.
   *  `ref` is a daemon path under `/api/brain/chat-images/` or the older `/api/brain/images/`. */
  | { type: 'image'; ref: string; id?: string; caption?: string }
  /** A general file the agent shared via `ShareFile`. The web renders `ref` as an authenticated download;
   *  `name` and `size` are display metadata preserved with the stored tool result. */
  | { type: 'file'; ref: string; name: string; size: number; id?: string; caption?: string }
  /** A transient runtime notice (rate-limit retry, context compaction) — so a stalled turn explains
   *  itself instead of just hanging on the spinner. `done` marks the end of that phase. */
  | { type: 'notice'; kind: 'retry' | 'compaction'; message: string; done?: boolean }
  /** A context compaction just PERSISTED: the daemon replaced the session's stored rows with PI's
   *  shrunk context (the summary + kept tail), so attached clients should refetch history and collapse
   *  their transcript to a 'context compacted' divider + that tail. Distinct from the compaction
   *  `notice` (the one-line status): this event drives the transcript REBUILD, the notice the status. */
  | { type: 'compacted' }
  /** The agent is asking the user to pick from predefined options and has PARKED the turn until they
   *  answer (see `AskUserQuestion` plugin + ElicitationRegistry). Synthetic — not derived from a PI
   *  event; the elicitor emits it straight into `listeners`. A client renders the questions as
   *  interactive choices and POSTs the answer to `/brain/answer` (Discord resolves it in-process).
   *  `kind: 'approval'` marks a blocking tool-permission prompt (three fixed options — see
   *  brain/toolPermissions.ts) so frontends can style it differently; absent = a regular question. */
  | { type: 'ask'; id: string; questions: AskQuestion[]; kind?: 'approval' }
  /** That parked question is SETTLED and every surface should stop showing it. The `ask` event fans out
   *  to all of a conversation's clients, so the CLI and the web raise the same question — without this
   *  the one that did NOT answer keeps showing a prompt that can no longer be answered (its POST would
   *  find nothing to match). `reason` distinguishes a real answer from a timeout, an abort, or the
   *  supersede when the model asks a second question, so a surface can say why it vanished. Synthetic,
   *  like `ask` itself, and emitted AFTER the entry is removed so a follow-up /brain/status is
   *  already consistent with it. */
  | { type: 'ask_resolved'; id: string; reason: 'answered' | 'timeout' | 'cancelled' }
  /** A new agent step (one model round-trip / turn) started within the current run. `step` is 1-based;
   *  `maxSteps` is the configured ceiling (0 = unlimited). `usage` snapshots context at step boundaries
   *  so clients don't wait until the final idle event to refresh context fill. Synthetic — counted
   *  daemon-side, not a raw PI event. */
  | { type: 'step'; step: number; maxSteps: number; usage?: BrainUsage; turnStartedAt?: number }
  /** The active conversation changed server-side mid-send: an idle conversation rolled over into a
   *  fresh session (see SESSION_IDLE_ROLLOVER_MS) and the triggering message runs there. Carries the
   *  NEW session id. Synthetic, like `ask`/`step` — emitted by send(), not derived from a PI event.
   *  The shared fold resets the transcript to the triggering turn; ignoring it is safe (the stream
   *  keeps flowing, only the visible history would look continued). */
  | { type: 'session'; sessionId: string }
  /** Host confirmation that an origin-bound result reached its external platform sink. Scheduler plugins
   *  must not infer this from `session`, which only proves where the turn ran. */
  | { type: 'delivery'; sessionId: string }
  /** Live progress of a delegated sub-agent run, keyed to the parent's `delegate` tool call by `id`.
   *  The delegating plugin emits these while the child session works (see `ctx.subagentEmitter`):
   *  `detail` mirrors the child's current tool, `tools`/`tokens`/`seconds` accumulate, and `sessionId`
   *  lets a client drill into the child's transcript (`GET /brain/messages?session=…`). Synthetic —
   *  fanned out to the PARENT conversation's listeners; ignoring it is always safe. */
  | { type: 'subagent'; id: string; sessionId: string; status: 'running' | 'done' | 'error'; task: string; detail?: string; tools: number; tokens?: number; seconds: number; model?: string; thinkingLevel?: string; thinkingLabel?: string; background?: boolean; autoDeliver?: boolean; resultDelivery?: 'pending' | 'acknowledged' }
  /** Live snapshot of a declarative sub-agent WORKFLOW (a DAG the delegating agent authored via
   *  `WorkflowStart`). One event per state change carries the WHOLE workflow — its overall status and
   *  the full node list with each node's dependencies, live status, and the child session/tokens/tool
   *  it is running. A client keeps the latest per `id`, renders the panel + drill-in modal, and may open
   *  a node's transcript via its `sessionId`. Synthetic and fanned out to the PARENT conversation's
   *  listeners exactly like `subagent`; ignoring it is always safe.
   *
   *  Two identifiers, and the distinction matters: `id` is the workflow's OWN identity (what
   *  `WorkflowAddNodes` addresses and what the panel keys on), while `toolCallId` is the origin's
   *  `WorkflowStart` call — the durable anchor that binds the DAG to a row in the parent's transcript,
   *  exactly as `subagent.id` does for a delegate call. A snapshot always names the ORIGIN's call, even
   *  when a node's own turn triggered it.
   *
   *  `background` (started with background:true, or detached with Ctrl+B) is NOT display trivia: a parent
   *  abort must SPARE such a workflow's node sessions exactly as it spares a detached delegate's child,
   *  and Ctrl+B must not count one that is already detached. */
  | { type: 'workflow'; id: string; toolCallId: string; title?: string; status: 'running' | 'done' | 'error' | 'cancelled'; background?: boolean; nodes: WorkflowNode[] }
  /** A visible, display-only marker that the owner changed session state out of turn — switched the
   *  model, work mode (build/plan/workflow), renamed the conversation, or changed the reasoning level.
   *  `subagent` and `workflow` are the delegated-work finish markers (see recordSubagentFinishMarker /
   *  recordWorkflowFinishMarker): a delegated child or a whole DAG reached a terminal state. Rendered as
   *  a subtle system line interleaved into the transcript by `at`; persisted (replayed on reconnect) but
   *  NEVER part of the model's context. Synthetic — safe to ignore. */
  | { type: 'session-event'; id: string; kind: 'model' | 'mode' | 'rename' | 'reasoning' | 'cwd' | 'subagent' | 'workflow'; detail: string; at: string }
  /** The pending message queue for this session — a FULL snapshot (an empty array clears it). Mapped
   *  from PI's native `queue_update` event: a message a user sends while a turn is already streaming is
   *  STEERED into the running turn (delivered between steps, before the next model call), and PI reports
   *  its transient steering + follow-up backlog here. A client renders the items as pending chips and
   *  boot-seeds from status().queued. Safe to ignore (the turn still streams). */
  | { type: 'queue'; items: { id: string; text: string }[] }
  /** A user message the DAEMON is rendering as the 'you' turn — the single authority for user echoes.
   *  Emitted right before EVERY real user turn runs: a normal (idle) send AND a drained queued delivery
   *  alike, so clients never echo optimistically (no client-side busy/isStreaming guess that could drop or
   *  duplicate the turn). `text` is the client's clean rendering when it supplied one (before
   *  @mention/prompt expansion), else the persisted model-facing text. Internal goal kickoff/continuation
   *  turns are NOT user messages and emit nothing. Safe to ignore (the streamed reply still arrives). */
  | {
      type: 'user';
      text: string;
      /** Store row replaced by this ordered live marker in snapshots. */
      durableId?: string;
      /** Attachments kept on disk for this turn. The sender's bubble draws them right away and the reload
       *  path rebuilds the identical thing from the store, so a refresh changes nothing on screen. */
      images?: BrainMessageImage[];
    }
  /** The DAEMON discarded a just-sent user turn: the user hit Esc/Stop before the turn produced any output,
   *  so its durable row was deleted and clients must pull the matching `you` bubble (`durableId`) from the
   *  transcript and restore `text` to the composer for editing/resending. Authoritative — a client never
   *  decides this itself (it cannot tell a first token racing the cancel). Only ever fires between a user
   *  turn's admission and its first output; safe to ignore (the row is already gone from the store, so a
   *  reconnect snapshot is consistent without it). */
  | { type: 'discard_user'; durableId: string; text: string }
  /** A FULL snapshot of the owner's background shell processes (the terminal plugin's
   *  `Bash(background:true)` children), pushed to the owner's live client streams whenever one
   *  spawns/exits/is killed — so the CLI/web process panel updates OUT of turn. Owner-only: a command
   *  line can carry a secret, so the daemon emits it only to the owner's own streams (never a second
   *  admin's). A client renders the running ones as a killable panel; empty snapshot clears it. Safe to
   *  ignore (the panel just stays stale until the next status refresh). */
  | { type: 'process'; processes: ProcessInfo[] }
  /** Authoritative autonomous-goal snapshot for this conversation. Emitted at every lifecycle mutation,
   * including the initial active row before the long kickoff turn settles. `null` means the goal was
   * cleared. Clients should replace their current goal state wholesale and may otherwise ignore it. */
  | { type: 'goal'; goal: BrainGoalState | null }
  | { type: 'idle'; usage?: BrainUsage; model?: string; durationMs?: number; completedAt?: string }
  | { type: 'error'; message: string };

/** The payload a delegating plugin pushes through `ctx.subagentEmitter()` — everything of the
 *  `subagent` BrainEvent except its `type` tag (the host adds that when fanning out). */
export type SubagentUpdate = Omit<Extract<BrainEvent, { type: 'subagent' }>, 'type'>;

/** One node of a `workflow` snapshot. `sessionId` is set once the node's child agent starts (drill-in
 *  target); `tokens`/`seconds`/`detail` accumulate the child's live progress; `deps` are the node ids
 *  that must finish before it runs. Bounded display data only — `result`/`error` carry a short preview
 *  of a terminal node's outcome (the full body reaches the parent via the WorkflowStart return), and
 *  `startedAt` (epoch ms) lets a client tick a running node's elapsed time between snapshots. */
export interface WorkflowNode {
  id: string;
  task: string;
  status: 'pending' | 'running' | 'done' | 'error';
  deps: string[];
  sessionId?: string;
  detail?: string;
  tokens?: number;
  seconds?: number;
  model?: string;
  startedAt?: number;
  result?: string;
  error?: string;
}

/** The payload the workflow engine pushes through `ctx.workflowEmitter()` — the whole `workflow`
 *  BrainEvent except its `type` tag (the host adds that when fanning out to the parent's clients). */
export type WorkflowUpdate = Omit<Extract<BrainEvent, { type: 'workflow' }>, 'type'>;

/** Terminal result emitted once by the delegating plugin. Unlike SubagentUpdate this carries the
 * bounded result body and is host-only: core persists it before it wakes the parent conversation. */
export interface SubagentCompletion {
  id: string;
  toolCallId: string;
  sessionId: string;
  task: string;
  status: 'done' | 'error';
  result?: string;
  error?: string;
  tools: number;
  tokens?: number;
  seconds: number;
  model?: string;
}

/** Terminal result emitted once by the workflow engine for a detached/background workflow. Unlike a
 *  live `workflow` snapshot this carries the whole-DAG summary body and is host-only: core persists it
 *  into the shared delegated-result inbox before waking the parent conversation. `status` may be
 *  'cancelled' (the store collapses that to an errored delivery; the summary body still says so). */
export interface WorkflowCompletion {
  id: string;
  toolCallId: string;
  title?: string;
  status: 'done' | 'error' | 'cancelled';
  result: string;
}

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
 *  "nothing to compact" identically. `customInstruction` (from `/compact <text>`) is forwarded to PI,
 *  which appends it to the summary prompt as an "Additional focus" line; empty/undefined runs a default
 *  compaction. */
export async function runCompaction(session: AgentSession, customInstruction?: string): Promise<CompactResult> {
  try {
    await session.compact(customInstruction);
    return { usage: usageOf(session), compacted: true };
  } catch (e) {
    if (isNoopCompactError(e)) return { usage: usageOf(session), compacted: false, message: 'Nothing to compact yet.' };
    throw e;
  }
}

/** One selectable option in an `ask` question. `description` is an optional one-line hint under the label.
 *  `preview` is optional monospace content (an ASCII mockup, a code snippet, a diagram) that lets the user
 *  SEE what the option means: when any option in a single-select question carries one, the picker switches
 *  to a side-by-side layout showing the focused option's preview beside the list. Surfaces without a
 *  side-by-side view (Discord, WhatsApp) simply ignore it.
 *
 *  On a question: `header` is a short chip label (≤30 chars); `multiSelect` allows more than one pick.
 *  `custom` says whether a free-text "Other" escape is offered — absent means true (older events predate
 *  the flag), so clients must treat only an explicit `false` as "options only".
 *
 *  Both shapes live in the shared wire contract and are re-exported here: the web needs the very same
 *  declaration, and this was a hand-copied duplicate until now. */
export type { AskQuestion };
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

/** PI's overflow detector expects a fully shaped assistant usage object, while tests/custom stream
 * adapters may omit it on provider errors. Normalize that optional field and only classify errored
 * assistants: a successful over-window response is compacted without retry and must stay durable. */
export function isErroredContextOverflow(message: unknown, contextWindow: number): boolean {
  if (!message || typeof message !== 'object') return false;
  const raw = message as { stopReason?: string; usage?: Record<string, unknown> };
  if (raw.stopReason !== 'error') return false;
  const usage = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    ...(raw.usage ?? {}),
  };
  try { return isContextOverflow({ ...(message as object), usage } as Parameters<typeof isContextOverflow>[0], contextWindow); }
  catch { return false; }
}

/** Add settled delegated-session spend while preserving the root conversation's live context fill. */
export function withDescendantUsage(usage: BrainUsage, extra: { totalTokens: number; cost: number }): BrainUsage {
  if (!extra.totalTokens && !extra.cost) return usage;
  return { ...usage, totalTokens: usage.totalTokens + extra.totalTokens, cost: usage.cost + extra.cost };
}

/** The usage figure an idle/status event reports: this session's own token+cost totals rolled up with its
 *  delegated descendants'. The single expression every idle/status emit site shares, so they can't drift. */
export function sessionUsageSnapshot(
  session: AgentSession,
  store: { descendantUsage(id: string): { totalTokens: number; cost: number } },
  sessionId: string,
): BrainUsage {
  return withDescendantUsage(usageOf(session), store.descendantUsage(sessionId));
}

/** A short human reason for a retry notice. Provider errors usually arrive as `429 {json blob}` — the
 *  raw blob is unreadable in a one-line notice, so dig the inner `error.message`/`message` out of the
 *  JSON (or drop the blob entirely) and cap the result to one compact clause. */
function retryReason(raw: unknown): string {
  if (!raw) return '';
  let text = String(raw);
  const brace = text.indexOf('{');
  if (brace >= 0) {
    const prefix = text.slice(0, brace).trim();
    try {
      const parsed = JSON.parse(text.slice(brace)) as { error?: { message?: string }; message?: string };
      const inner = typeof parsed.error?.message === 'string' ? parsed.error.message : typeof parsed.message === 'string' ? parsed.message : '';
      text = inner || prefix;
    } catch { text = prefix; }
  }
  return collapseWhitespace(text).slice(0, 70);
}

/** Only this tool streams live progress — every other tool's `tool_execution_update` is dropped so a
 *  chatty tool can't re-flood the SSE with the raw output it already returns once at the end. */
const PROGRESS_TOOL = 'Bash';
/** At most one `tool_progress` per tool call per this window — the ceiling on how often a running
 *  command can push a partial to every attached client. Paired with the plugin's own onData throttle
 *  (the primary emission rate limit); this is the defensive second gate at the single mapping point. */
const PROGRESS_THROTTLE_MS = 100;
/** Bounded rolling TAIL kept from a partial result — a runaway command's live view stays a few screens,
 *  never its whole buffer. Errors live at the end of shell output, so we keep the tail, not the head. */
const PROGRESS_TAIL_CHARS = 2_000;
/** Per-`toolCallId` timestamp of the last emitted `tool_progress`, for the throttle above. Entries are
 *  dropped on the matching `tool_execution_end`, so the map never outgrows the set of live tool calls. */
const lastProgressAt = new Map<string, number>();

/** At most one `tool_authoring` detail update per authoring tool call per this window — the ceiling on
 *  how often the streaming argument detail (e.g. a growing file path) re-emits while the model writes a
 *  call. Mirrors `PROGRESS_THROTTLE_MS` but wider: the detail only needs to settle to a readable label,
 *  not stream live. */
const AUTHORING_THROTTLE_MS = 250;
/** Per-authoring-call last emitted detail + timestamp, for the change-detection + throttle in the
 *  `toolcall_delta` mapping. Entries are dropped when the tool actually starts/ends executing (its
 *  authoring window is over), so the map never outgrows the set of in-flight calls. */
const lastAuthoringAt = new Map<string, { detail: string | undefined; reason: string | undefined; at: number }>();

/** Hard cap on the throttle maps above. They are normally released on `tool_execution_start`/`_end`, but a
 *  call the model only *drafts* — an aborted turn / Esc mid-authoring — never reaches those events, so its
 *  entry would leak for the daemon's lifetime (the maps are process-global, shared by all sessions). Bound
 *  them by evicting the oldest-inserted entry; that only ever resets a stale throttle slot. */
const THROTTLE_MAP_CAP = 1024;
function capSet<V>(map: Map<string, V>, key: string, value: V): void {
  if (!map.has(key) && map.size >= THROTTLE_MAP_CAP) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

/** Extract the rolling tail of text from a PI `partialResult` (same `{ content: [{ text }] }` shape as
 *  a final tool result). Concatenates the text parts and keeps only the last `PROGRESS_TAIL_CHARS`. */
function progressTail(partial: unknown): string {
  const parts = (partial as { content?: { text?: string }[] } | undefined)?.content;
  let text = '';
  for (const part of Array.isArray(parts) ? parts : []) if (typeof part?.text === 'string') text += part.text;
  text = text.replace(/\s+$/, '');
  return text.length > PROGRESS_TAIL_CHARS ? text.slice(text.length - PROGRESS_TAIL_CHARS) : text;
}

/** Translate a PI session event into the stable BrainEvent contract. Defensive: unknown event types
 *  are dropped. `now` is injectable so the `tool_progress` throttle is deterministic in tests. */
export function toBrainEvent(e: AgentSessionEvent, now: number = Date.now()): BrainEvent | null {
  if (e.type === 'agent_end') {
    const timed = e as AgentSessionEvent & { turnDurationMs?: number; turnCompletedAt?: string };
    return {
      type: 'idle',
      ...(timed.turnDurationMs != null ? { durationMs: timed.turnDurationMs } : {}),
      ...(timed.turnCompletedAt ? { completedAt: timed.turnCompletedAt } : {}),
    };
  }
  const anyE = e as {
    type: string; toolName?: string; args?: unknown; result?: { details?: { diff?: unknown; sharedImage?: unknown; sharedFile?: unknown } }; isError?: boolean;
    toolCallId?: string; partialResult?: unknown;
    // toolcall_start additionally carries the in-progress assistant message: the tool NAME is already on
    // the partial block at `contentIndex` (only its arguments stream in later), so we thread it out.
    assistantMessageEvent?: {
      type?: string; delta?: string; contentIndex?: number;
      partial?: { content?: { type?: string; name?: string; id?: string; arguments?: unknown }[] };
    };
    attempt?: number; maxAttempts?: number; errorMessage?: string; success?: boolean;
    // compaction_end carries its outcome: `result` is the CompactionResult on success, undefined on a
    // no-op/failure; `aborted` marks a cancelled run. Both let the status line avoid a false success.
    aborted?: boolean;
    // queue_update carries PI's transient pending backlog (steered + follow-up messages).
    steering?: readonly string[]; followUp?: readonly string[];
  };
  // PI's native pending-message backlog — a mid-turn steered message shows as a chip until it's delivered.
  if (anyE.type === 'queue_update') return { type: 'queue', items: queueItems(anyE.steering ?? [], anyE.followUp ?? []) };
  if (anyE.type === 'message_update') {
    const ev = anyE.assistantMessageEvent;
    if (ev?.type === 'text_delta' && ev.delta) return { type: 'text', delta: ev.delta };
    // The model's reasoning stream (extended-thinking models) — a first-class, separately-rendered event.
    if (ev?.type === 'thinking_delta' && ev.delta) return { type: 'reasoning', delta: ev.delta };
    // The model started composing a tool call — surface the authoring window as a live "working" hint.
    // Every provider adapter emits `toolcall_start` before the arguments stream; the delta events after it
    // are the args accumulating and stay dropped (the marker, not the raw JSON, is what renders). The tool
    // NAME is already on the partial block at start (only its arguments stream in later), so thread it out
    // to let the hint show the real tool (e.g. "Write") instead of a generic placeholder.
    if (ev?.type === 'toolcall_start') {
      const block = typeof ev.contentIndex === 'number' ? ev.partial?.content?.[ev.contentIndex] : undefined;
      const name = block?.type === 'toolCall' && typeof block.name === 'string' ? block.name : undefined;
      return name ? { type: 'tool_authoring', name } : { type: 'tool_authoring' };
    }
    // The call's arguments are streaming in. Read the same partial block the start event carried and
    // re-derive the salient detail (file path, command, query…) so a long-duration tool can upgrade the
    // generic authoring hint to a localized action label. Emit only when the derived detail CHANGED for
    // this call's id, throttled per id — a chatty delta stream would otherwise re-noise the SSE with the
    // same label. Without a resolvable block (no contentIndex/partial) there is nothing to show, so drop.
    if (ev?.type === 'toolcall_delta') {
      const block = typeof ev.contentIndex === 'number' ? ev.partial?.content?.[ev.contentIndex] : undefined;
      if (block?.type !== 'toolCall') return null;
      const name = typeof block.name === 'string' ? block.name : undefined;
      const id = typeof block.id === 'string' ? block.id : undefined;
      const last = id ? lastAuthoringAt.get(id) : undefined;
      // Inside the throttle window the answer is already decided, EXCEPT for the one case that is allowed
      // to bypass it (the delta first carrying a reason) — and that cannot happen once a reason is known.
      // Deriving the label first would parse the whole accumulated argument JSON on every chunk only to
      // throw the result away, which is work the event loop does not have to spare while a tool authors a
      // large payload.
      if (last && last.reason !== undefined && now - last.at < AUTHORING_THROTTLE_MS) return null;
      const detail = toolDetail(block.arguments, name);
      // The model-authored `reason` (the tool's leading arg) as it streams — it supersedes the derived
      // label in the CLI. Grows character-by-character; `toolDetail` never reads `reason`, so detail is
      // unaffected. A reason-only change must still emit, so it joins the dedup key below.
      const reason = extractReason(block.arguments);
      if (!id) return (detail || reason) ? { type: 'tool_authoring', ...(name ? { name } : {}), detail, ...(reason ? { reason } : {}) } : null;
      if (last && last.detail === detail && last.reason === reason) return null; // unchanged → nothing new
      // The delta that FIRST carries a reason bypasses the throttle window: a provider that still delivers
      // arguments in a late burst emits only one reason-bearing delta before the tool starts executing, and
      // the window must not swallow it. Subsequent reason growth stays throttled (a smooth ~4fps label).
      const reasonFirstAppeared = reason !== undefined && (!last || last.reason === undefined);
      if (last && now - last.at < AUTHORING_THROTTLE_MS && !reasonFirstAppeared) return null; // else throttle
      capSet(lastAuthoringAt, id, { detail, reason, at: now });
      return { type: 'tool_authoring', ...(name ? { name } : {}), detail, ...(reason ? { reason } : {}) };
    }
    return null;
  }
  // Runtime notices so a stalled turn explains itself instead of hanging silently on the spinner.
  if (anyE.type === 'auto_retry_start') {
    const reason = retryReason(anyE.errorMessage);
    return { type: 'notice', kind: 'retry', message: `reconnecting ${anyE.attempt ?? 1}/${anyE.maxAttempts ?? 1}${reason ? ` · ${reason}` : ''}…` };
  }
  if (anyE.type === 'auto_retry_end') return { type: 'notice', kind: 'retry', message: anyE.success ? 'reconnected' : 'reconnect failed', done: true };
  if (anyE.type === 'compaction_start') return { type: 'notice', kind: 'compaction', message: 'compacting conversation…' };
  if (anyE.type === 'compaction_end') {
    // Only a REAL compaction (a CompactionResult present, not aborted) says "context compacted"; a no-op
    // (session too small / already compacted) or a failed/cancelled run just clears the status line — PI
    // emits compaction_start then a resultless compaction_end for those, so an unconditional success text
    // would lie. An empty message with `done` clears the notice without claiming anything happened.
    const ok = anyE.result != null && anyE.aborted !== true;
    return { type: 'notice', kind: 'compaction', message: ok ? 'conversation compacted' : '', done: true };
  }
  // Live streamed output of a running tool. Scoped to `Bash` ONLY (every other tool would just
  // re-noise the SSE with output it returns once at the end anyway) and throttled per tool call, so a
  // long build/test streams a bounded rolling tail live. The final `tool_output` for this id supersedes
  // the partial in the reducer, so a dropped in-window update is harmless.
  if (anyE.type === 'tool_execution_update') {
    if (anyE.toolName !== PROGRESS_TOOL || typeof anyE.toolCallId !== 'string') return null;
    const last = lastProgressAt.get(anyE.toolCallId) ?? 0;
    if (now - last < PROGRESS_THROTTLE_MS) return null;
    const text = progressTail(anyE.partialResult);
    if (!text) return null;
    capSet(lastProgressAt, anyE.toolCallId, now);
    return { type: 'tool_progress', id: anyE.toolCallId, text };
  }
  // Emit the tool name ONCE, when it starts — never the raw streamed output (_update noise).
  if (anyE.type === 'tool_execution_start' && typeof anyE.toolName === 'string') {
    if (typeof anyE.toolCallId === 'string') lastAuthoringAt.delete(anyE.toolCallId); // authoring is over
    // The start event carries the arguments (the end event does not), so the verbatim shell command is
    // captured HERE and threaded to the output on the matching end event by the transcript reducer.
    const display = toolDisplay(anyE.toolName, anyE.args);
    return { type: 'tool', name: display.name, detail: display.detail, command: toolCommand(anyE.args), id: anyE.toolCallId };
  }
  // Edits carry a display diff in their result details — that's the one tool output worth showing.
  if (anyE.type === 'tool_execution_end') {
    if (typeof anyE.toolCallId === 'string') { lastProgressAt.delete(anyE.toolCallId); lastAuthoringAt.delete(anyE.toolCallId); } // release the throttle slots
    const diff = anyE.result?.details?.diff;
    if (typeof diff === 'string' && diff.trim()) {
      // A hook-annotated edit (details.notes) keeps its note: toolOutputView builds a notes-only view
      // for diff results, riding the diff event so live rendering matches the history path.
      const output = typeof anyE.toolName === 'string' ? toolOutputView(anyE.toolName, anyE.args, anyE.result, anyE.isError === true) : undefined;
      return { type: 'diff', diff, id: anyE.toolCallId, ...(output ? { output } : {}) };
    }
    // ShareImage/ShareFile state their intent structurally, so neither needs text sniffing: the immutable
    // bytes and display metadata are already stored in the result details.
    const sharedFile = anyE.result?.details?.sharedFile as { file?: unknown; name?: unknown; size?: unknown; caption?: unknown } | undefined;
    if (typeof sharedFile?.file === 'string' && typeof sharedFile.name === 'string' && typeof sharedFile.size === 'number') {
      return {
        type: 'file', ref: `/api/brain/chat-files/${sharedFile.file}`, name: sharedFile.name, size: sharedFile.size, id: anyE.toolCallId,
        ...(typeof sharedFile.caption === 'string' && sharedFile.caption ? { caption: sharedFile.caption } : {}),
      };
    }
    const shared = anyE.result?.details?.sharedImage as { file?: unknown; mimeType?: unknown; caption?: unknown } | undefined;
    if (typeof shared?.file === 'string') {
      return {
        type: 'image', ref: `/api/brain/chat-images/${shared.file}`, id: anyE.toolCallId,
        ...(typeof shared.caption === 'string' && shared.caption ? { caption: shared.caption } : {}),
      };
    }
    // Image tools return a markdown link to the stored file; surface it as a first-class event so
    // channel adapters can attach the real file (models often omit the link from their final text). Skip
    // Bash: its console output can legitimately print such a path (grep/cat over stored transcripts,
    // curl of our own API) and turning that into an `image` event instead of `tool_output` would strand the
    // live progress tail — the reducer only reconciles (drops) progress on tool_output/diff for the id.
    if (anyE.toolName !== PROGRESS_TOOL) {
      const parts = (anyE.result as { content?: { type?: string; text?: string }[] } | undefined)?.content;
      for (const part of Array.isArray(parts) ? parts : []) {
        const m = typeof part?.text === 'string' ? /\((\/api)?\/brain\/images\/([a-z0-9]+\.png)\)/.exec(part.text) : null;
        if (m) return { type: 'image', ref: `/api/brain/images/${m[2]}`, id: anyE.toolCallId };
      }
    }
    if (typeof anyE.toolName === 'string') {
      // `anyE.args` is absent on the end event; the command is threaded via the reducer instead. The
      // event-level `isError` flag IS authoritative here, so pass it through for a correct live tone.
      const output = toolOutputView(anyE.toolName, anyE.args, anyE.result, anyE.isError === true);
      const plan = submittedPlan(anyE.toolName, anyE.result);
      if (output) return { type: 'tool_output', output, id: anyE.toolCallId, ...(plan ? { plan } : {}) };
      return { type: 'tool_end', id: anyE.toolCallId, ...(anyE.isError === true ? { isError: true } : {}), ...(plan ? { plan } : {}) };
    }
  }
  return null;
}

/** Map PI's pending steering + follow-up backlog (both plain string arrays) to the queue snapshot the
 *  clients render as removable chips. PI mints no ids for these transient, between-steps-delivered
 *  messages, so the position is the stable-enough handle. Steering messages come first (they land ahead
 *  of any follow-up). Shared by the `queue` event mapping and status().queued so both agree. */
export function queueItems(steering: readonly string[], followUp: readonly string[]): { id: string; text: string }[] {
  return [...steering, ...followUp].map((text, i) => ({ id: String(i), text }));
}

/** Snapshot a session's statusline numbers: context fill from PI plus per-message usage totals. Internal
 *  to this module now — callers use {@link sessionUsageSnapshot} to also roll up delegated descendants. */
/** PI's `getContextUsage` throws on a shape it produces itself. Once a session carries a compaction
 *  entry it scans back for an assistant that answered AFTER it, and calls `calculateContextTokens`
 *  on that message's `usage` WITHOUT a guard — while its own sibling helper in the same library
 *  (`getAssistantUsage`) checks for the field first. An assistant that stops on `toolUse` carries no
 *  usage at all (the totals land on the final message of the turn), so any compacted session throws
 *  here the moment it calls a tool.
 *
 *  Reported to the library. Until it lands: the missing context figure is a STATUSLINE number, and
 *  `undefined` is the value this function already treats as "context fill unknown" — the very state
 *  PI itself returns (`tokens: null`) when it finds no post-compaction usage. Losing an entire answer
 *  over a progress percentage is the worse failure, so the turn survives with the number unknown. */
function contextUsageOf(session: AgentSession): ReturnType<AgentSession['getContextUsage']> | undefined {
  try { return session.getContextUsage(); }
  catch { return undefined; }
}

function usageOf(session: AgentSession): BrainUsage {
  const ctx = contextUsageOf(session);
  let totalTokens = 0;
  let cost = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let reasoning = 0;
  let measuredOutput = 0;
  let measuredMs = 0;
  for (const m of session.messages as {
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; totalTokens?: number; cost?: { total?: number } };
    durationMs?: number;
  }[]) {
    totalTokens += m.usage?.totalTokens ?? 0;
    cost += m.usage?.cost?.total ?? 0;
    input += m.usage?.input ?? 0;
    output += m.usage?.output ?? 0;
    cacheRead += m.usage?.cacheRead ?? 0;
    cacheWrite += m.usage?.cacheWrite ?? 0;
    reasoning += m.usage?.reasoning ?? 0;
    // Speed only over generations that carry the projector's timing stamp — same measured-only
    // weighting as the store's per-model aggregate.
    if (m.durationMs && m.durationMs > 0 && m.usage?.output) { measuredOutput += m.usage.output; measuredMs += m.durationMs; }
  }
  return {
    tokens: ctx?.tokens ?? null, contextWindow: ctx?.contextWindow ?? 0, percent: ctx?.percent ?? null, totalTokens, cost,
    input, output, cacheRead, cacheWrite, reasoning,
    outputTps: measuredMs > 0 ? measuredOutput / (measuredMs / 1000) : null,
  };
}
