import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { fsSafeSegment, sessionToolResultSpillDir, sessionToolResultSpillNamespace } from '../../shared/paths.js';
import { logger } from '../../shared/logger.js';
import {
  GUEST_WRITE_OP_BYTES,
  guestSpillDirForNamespace,
  guestArtifactDestinationPath,
  readGuestFileBounded,
  resolveManagedArtifactTurn,
  writeGuestFile,
  type SandboxResolver,
} from '../managedArtifacts.js';
import { currentProjectRef } from '../../plugins/policyContext.js';
import type { PiAgentMessage } from './historyImageStripping.js';
import { isUserTurn } from './userTurn.js';

/** Keeping large tool results out of the context, and the stored transcript honest about it.
 *
 *  The full text is written to `<dataDir>/tool-results/<spillNs>/<toolCallId>.v1-<mode>-<bytes>.txt`
 *  (write-once, `wx`) BEFORE the placeholder replaces it, so nothing is lost that the model could not
 *  read back — pathGuard lets every session read its own spill directory. The byte count and the mode
 *  live in the file NAME purely to make it unique; nothing parses them back.
 *
 *  Anthropic's prompt cache is prefix-based, so the one rule that governs all of this is: NEVER rewrite
 *  history the provider could still have cached. There are two moments where that rule is satisfiable,
 *  and this codebase has one trigger at each:
 *
 *  · DELIVERY, in `afterToolCall` ({@link installToolResultDeliverySpill} below) — the size trigger and
 *    the aggregate group budget. The content has never been sent, so replacing it appends a smaller
 *    block to the prefix instead of rewriting a cached one. Because the placeholder exists before PI
 *    builds the tool-result message, the stored row carries it from the start and there is no rewrite of
 *    anything, anywhere.
 *  · The START of a turn whose cache has provably expired (`coldToolResultClearing.ts`) — the time
 *    trigger, for results that HAVE been sent. It writes the spill, the rows and the live messages in
 *    one pass, so the store and the wire agree afterwards without any latch to hold them together.
 *
 *  Both write a structural marker into the result's `details` ({@link isClearedToolResult}), which is
 *  what stops a placeholder from ever being spilled a second time.
 *
 *  This module holds the shared pieces: the thresholds, the placeholder, the spill path, the selection
 *  and the delivery-time trigger. */

const log = logger('brain-tool-clearing');

/** Which trigger spilled a result. Only ever used to name the cause in the log — a cacheWatch warning
 *  names the message index, and this names who rewrote it. */
type SpillTrigger = 'time' | 'size' | 'group';

/** The ceiling every placeholder stays under, and the floor a build WITHOUT the structural marker would
 *  select on. 4 KB ≈ 1k tokens.
 *
 *  It is no longer the cold pass's own floor ({@link COLD_CLEAR_MIN_BYTES} is), and the two have different
 *  jobs: this one keeps a placeholder from ever being mistaken for a clearable result by a build that can
 *  only judge by size — a rollback to one — while the cold floor decides what is worth clearing today. */
export const CLEAR_MIN_BYTES = 4096;

/** Results smaller than this stay in context at a cold turn start: clearing them costs a spill file and a
 *  placeholder of ~200 bytes, so the saving has to be worth the file.
 *
 *  1 KB rather than 4 KB because 4 KB measured badly on real conversations. Simulated over four live
 *  sessions, the old floor cleared nothing at all on the owner's own session (its largest tool result was
 *  2 864 B) and left 19k tokens on the table on a tool-heavy one; 1 KB clears 2 928 and 25 931 tokens
 *  there respectively. Below 1 KB the placeholder starts to be a comparable fraction of what it replaces.
 *
 *  The DELIVERY triggers are deliberately untouched by this: they fire on {@link SPILL_MAX_RESULT_BYTES}
 *  and {@link TOOL_RESULT_GROUP_BUDGET_BYTES}, both far above either floor, and their placeholder preview
 *  is bounded by {@link CLEAR_MIN_BYTES} — lowering that bound instead would have shrunk the preview the
 *  model reads on every large result. */
export const COLD_CLEAR_MIN_BYTES = 1024;

/** A single fresh result above this size is spilled the moment it would be delivered, without waiting
 *  for the idle gate: at ~12k tokens one result of this size costs more context than the whole rest of
 *  a typical turn, and the model can read it back in full from the spill path.
 *
 *  50 000 is Claude Code's DEFAULT_MAX_RESULT_SIZE_CHARS, kept as the DEFAULT of the operator-tunable
 *  `toolResultInlineBytes` knob (Elowen AI → Limits) — `toolOutputMaxChars` caps the TRANSCRIPT preview,
 *  not what the model receives, so it neither bounds nor competes with this. Measured in bytes rather than
 *  characters because this module already measures in bytes (textBytes, CLEAR_MIN_BYTES); for the
 *  ASCII-dominant output that reaches this size the two differ by a rounding error, and one measure beats
 *  two. */
export const SPILL_MAX_RESULT_BYTES = 50_000;

/** Aggregate cap on ONE wire-level tool-result message. pi-ai's Anthropic converter coalesces every RUN
 *  of consecutive `toolResult` messages into a single `user` message (`convertMessages`), so the parallel
 *  tool calls of one turn reach the provider as one block — and that block, not the individual result, is
 *  what the context pays for. The per-result trigger cannot see it: eight parallel searches of 30 kB each
 *  add ~240 kB while every one of them sits comfortably under SPILL_MAX_RESULT_BYTES.
 *
 *  200 000 is Claude Code's per-message budget and lands in the right place here too — four full-size
 *  single-result spills, ~50k tokens, the point at which one turn's fan-out alone costs a quarter of a
 *  200k context window. Kept as the DEFAULT of the operator-tunable `toolResultGroupBudgetBytes` knob
 *  (Elowen AI → Limits). Bytes rather than characters for the same reason as SPILL_MAX_RESULT_BYTES. */
export const TOOL_RESULT_GROUP_BUDGET_BYTES = 200_000;

/** The aggregate trigger's threshold, resolved live through the same seam as the per-result one above, so
 *  a Limits change applies to the very next transform rather than to the next daemon start. */
let toolResultGroupBudget: () => number = () => TOOL_RESULT_GROUP_BUDGET_BYTES;
export function setToolResultGroupBudget(resolve: () => number): void { toolResultGroupBudget = resolve; }

/** The size trigger's threshold, resolved live so a Limits change applies without a restart — the same
 *  module-level-resolver seam messageView uses for its tool-output caps ({@link setToolOutputCaps}).
 *  Injected once at bootstrap; defaults to {@link SPILL_MAX_RESULT_BYTES} so tests and any un-wired path
 *  keep the historical behaviour. */
let spillMaxResultBytes: () => number = () => SPILL_MAX_RESULT_BYTES;
export function setSpillMaxResultBytes(resolve: () => number): void { spillMaxResultBytes = resolve; }

/** How much of a size-spilled result the placeholder carries, so the model can tell what it got — and
 *  whether it is worth a Read — without the full text. 2 000 matches Claude Code's preview budget.
 *  Sliced by CHARACTERS on purpose: a byte slice can cut a multi-byte character in half, and the point
 *  of the cap is bounding the placeholder, which a char count does well enough. */
export const SPILL_PREVIEW_CHARS = 2000;

/** How many trailing user turns keep their tool results intact: the current run (after the last user
 *  message) plus the whole previous turn. Everything older is eligible once the gate opens. */
export const KEEP_USER_TURNS = 2;

/** The same retention measured at the START of a turn, BEFORE the user's new message is admitted. One
 *  fewer, because that message is exactly what the egress-time count had and this one does not: keeping 2
 *  here would silently retain three turns' worth of results and clear measurably less than the pass it
 *  replaces. */
export const TURN_START_KEEP_USER_TURNS = KEEP_USER_TURNS - 1;

/** The message's own timestamp — the second half of a toolResult occurrence's identity, the id being the
 *  first. 0 when it carries none: a message from an old enough build may predate the field, and a hook
 *  upstream could hand anything through. */
function messageOccurredAt(message: ToolResultMessage): number {
  const at = (message as { timestamp?: unknown }).timestamp;
  return typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : 0;
}

/** Deterministic spill path — the placeholder builds it without any I/O, so the transform stays pure.
 *  The id is fs-encoded like the session id: a provider/plugin-minted toolCallId containing `/` or
 *  `..` must not escape the spill dir (pathGuard would refuse the escaped path and the cleared
 *  content would be unreadable). */
export function toolResultSpillPath(spillDir: string, toolCallId: string, descriptor: SpillDescriptor): string {
  return join(spillDir, `${fsSafeSegment(toolCallId)}.${SPILL_NAME_VERSION}-${descriptor.mode}-${descriptor.bytes}.txt`);
}

/** What the spill FILE NAME carries beyond the content. `bytes` is the sum of the individual text blocks'
 *  byte lengths, while the file holds those blocks joined by '\n' — so for an n-block result the file is
 *  n-1 bytes larger and the number cannot be recovered by measuring it. `mode` says which placeholder
 *  wording was used. Putting both in the name makes the spill a single atomic write that persists the
 *  content and its metadata together: there is no window in which one exists without the other, and no
 *  second store to keep in sync.
 *
 *  Version prefix on purpose: the v1 rules include the preview length and the placeholder wording. A future
 *  change to either must mint v2 rather than reinterpret v1 names — the store's own migrations rebuild v1
 *  placeholders from these names and have to reproduce them byte for byte. */
export interface SpillDescriptor { mode: 'time' | 'preview'; bytes: number }

const SPILL_NAME_VERSION = 'v1';

/** Name of a tool's COMPLETE output persisted by {@link persistToolOutputSpill}. Deliberately outside the
 *  `time|preview` grammar a cleared result uses: this file is NOT the spill of the result the model
 *  received — that result carries an excerpt — so the two can never collide on one name. Everything else
 *  (directory, fs-safe id encoding, version prefix, the byte count in the name) is the same, so there is
 *  one naming authority for this directory. */
function toolOutputSpillPath(spillDir: string, toolCallId: string, bytes: number): string {
  return join(spillDir, `${fsSafeSegment(toolCallId)}.${SPILL_NAME_VERSION}-output-${bytes}.txt`);
}

/** Persist the COMPLETE output of one tool call, for a tool whose inline result can only carry a bounded
 *  excerpt of it (the terminal plugin's foreground Bash). Same store as the clearing spills above, reached
 *  by plugins through `ctx.persistToolOutput`: same directory, same naming, and therefore the same
 *  lifecycle for free — pathGuard already lets the OWNING session Read the file back, and deleting or
 *  clearing the conversation removes the whole directory with it. A second store would have to re-earn
 *  both.
 *
 *  Write-once (`wx`) with the same EEXIST reconciliation the clearing spills use, for the same reason: a
 *  toolCallId is not unique on its own (sequential `call_0` styles reset every turn — see
 *  {@link ClearableResult}), so a later call CAN land on an existing name, and only when its output
 *  is byte-identical in size at that. Overwriting would then swap the content under a path an earlier
 *  result still tells the model to read, with nothing marking the swap. Identical bytes are the same file
 *  and are simply adopted; a genuine conflict returns null, and the caller keeps whatever it does when
 *  nothing could be stored.
 *
 *  MANAGED ROUTE: on a managed-project turn the ambient caller (the plugin context) has no readable
 *  host path for the model, so the output is persisted into the MANAGED PROJECT instead — same
 *  immutable namespace, same naming authority, provider write with the EEXIST adoption — and the
 *  returned `path` is the GUEST path the model can read. The host `spillDir` argument is ignored on
 *  that branch. Provider absent/malformed/failing → `null` (the caller's established "nothing was
 *  stored" answer, so the output stays whole in the result) plus an error-level log, NEVER a host
 *  write the model could not read. */
export async function persistToolOutputSpill(
  spillDir: string,
  toolCallId: string,
  text: string,
): Promise<{ path: string; bytes: number } | null> {
  const bytes = Buffer.byteLength(text, 'utf8');
  const managed = currentProjectRef()?.kind === 'managed';
  if (managed) {
    return await persistManagedToolOutput(toolCallId, text, bytes);
  }
  const path = toolOutputSpillPath(spillDir, toolCallId, bytes);
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, text, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (await readFile(path, 'utf8').catch(() => null) !== text) {
      log.warn(`a different file already occupies the output spill path for ${toolCallId} — not storing this output`);
      return null;
    }
  }
  return { path, bytes };
}

/** The managed branch of {@link persistToolOutputSpill}: write into the session's guest spill directory
 *  through the live provider, create-once with the same EEXIST adoption, guest path returned. */
async function persistManagedToolOutput(
  toolCallId: string,
  text: string,
  bytes: number,
): Promise<{ path: string; bytes: number } | null> {
  const resolved = await resolveManagedArtifactTurn(managedSandboxSeam());
  if (typeof resolved === 'string') {
    log.error(`managed tool output spill unavailable for ${toolCallId}: ${resolved} — the output stays whole in the result, NOT stored on the host`);
    return null;
  }
  if (bytes > GUEST_WRITE_OP_BYTES) {
    log.error(`managed tool output spill for ${toolCallId} exceeds the ${GUEST_WRITE_OP_BYTES / 1024} KiB guest write limit — the output stays whole in the result, NOT stored`);
    return null;
  }
  const guest = {
    sandbox: resolved.sandbox,
    projectRef: resolved.turn.projectRef,
    accountUserId: resolved.turn.accountUserId,
  };
  const dir = guestSpillDirForNamespace(sessionToolResultSpillNamespace(resolved.turn.sessionId));
  const path = toolOutputSpillPath(dir, toolCallId, bytes);
  const written = await writeGuestFile(guest, path, Buffer.from(text, 'utf8'));
  if (typeof written === 'string') {
    // A file already at the path: adopt an identical survivor, refuse anything else — same
    // reconciliation as the host branch above.
    const onDisk = await readGuestFileBounded(guest, path, GUEST_WRITE_OP_BYTES);
    if (typeof onDisk !== 'string' && onDisk.equals(Buffer.from(text, 'utf8'))) return { path, bytes };
    log.error(`managed tool output spill for ${toolCallId} failed (${written}) — the output stays whole in the result, NOT stored`);
    return null;
  }
  return { path, bytes };
}

/** The one placeholder shape both triggers use. With a preview the wording says the result was never put
 *  in the context (the delivery triggers); without one it says an older result was cleared (the cold
 *  turn-start pass). The preview follows the bracketed notice as plain text so the notice itself stays a
 *  single line. Editing this wording changes future clearings only — an already cleared result carries
 *  its placeholder in its own row and is never re-rendered. */
export function clearedToolResultPlaceholder(
  spillPath: string,
  originalBytes: number,
  preview?: string,
): string {
  if (preview === undefined) {
    return `[Older tool result cleared to save context. Full output saved at: ${spillPath} — read it with the Read tool if needed. Original size: ${originalBytes} bytes.]`;
  }
  return `[Large tool result (${originalBytes} bytes) saved to disk instead of the context. Full output at: ${spillPath} — read it with the Read tool if needed. First ${preview.length} characters below.]\n${preview}`;
}

/** Where a cleared result's structural identity lives: one key inside the tool result's own `details`.
 *  `details` is carried verbatim through every reader that matters — the pending row written at
 *  `message_end`, the `agent_end` re-persist, rehydration (`parsedRows` keeps the whole message object)
 *  and the fork seed — so the marker survives exactly as far as the placeholder text does.
 *
 *  It is deliberately NOT a text prefix. A placeholder's opening characters are not an identity: a
 *  legitimate output can begin with the same bytes — a Read of a spill file, a DelegateRead of a
 *  transcript that quotes one, a `journalctl` line — and a prefix test would then declare a real tool
 *  result "already cleared" and skip it forever. */
export const CLEARED_TOOL_RESULT_DETAIL = 'clearedToolResult';

/** What the marker records: enough to explain the row without re-parsing the placeholder text, and
 *  nothing the placeholder does not already say out loud. */
export interface ClearedToolResultMarker {
  mode: SpillDescriptor['mode'];
  bytes: number;
  path: string;
}

/** The `details` a cleared result carries: whatever the tool produced, plus the marker. The tool's own
 *  details are preserved on purpose — a diff, a shared image or a shared file still renders in the
 *  transcript after the text has moved to disk. */
export function clearedToolResultDetails(details: unknown, marker: ClearedToolResultMarker): Record<string, unknown> {
  const base = details && typeof details === 'object' && !Array.isArray(details)
    ? details as Record<string, unknown>
    : {};
  return { ...base, [CLEARED_TOOL_RESULT_DETAIL]: marker };
}

/** Has this result already been replaced by a placeholder? Structural, so it answers for a message that
 *  was cleared in this process, one rehydrated from a row and one inherited through a fork seed alike.
 *
 *  The guard exists because a placeholder is itself a tool result of ordinary shape: a preview
 *  placeholder quotes up to {@link SPILL_PREVIEW_CHARS} characters, and in a multi-byte script that is
 *  several kilobytes — comfortably past {@link CLEAR_MIN_BYTES}, i.e. a selection candidate. Without the
 *  marker the cold pass would spill a placeholder into a second file and nest a placeholder inside a
 *  placeholder, losing the path to the real output from the context. */
export function isClearedToolResult(message: unknown): boolean {
  const details = (message as { details?: unknown } | null)?.details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return false;
  const marker = (details as Record<string, unknown>)[CLEARED_TOOL_RESULT_DETAIL];
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return false;
  const { mode, bytes, path } = marker as Record<string, unknown>;
  return (mode === 'time' || mode === 'preview') && typeof bytes === 'number' && typeof path === 'string';
}

/** The preview a size/group placeholder quotes: at most {@link SPILL_PREVIEW_CHARS} characters AND few
 *  enough of them that the finished placeholder stays under {@link CLEAR_MIN_BYTES}.
 *
 *  The character cap alone is not enough, and the byte bound is not cosmetic — it is what keeps a
 *  ROLLBACK safe. A build without {@link isClearedToolResult} recognises a cleared result only by its
 *  size: anything at or above CLEAR_MIN_BYTES is a clearing candidate. A 2 000-character CJK preview is
 *  ~6 kB, so reverting to such a build would spill the placeholder itself and hand the model a nested
 *  placeholder naming a file that holds nothing but another placeholder. Under the bound the placeholder
 *  is simply a small tool result to any build, past or future, and nothing selects it.
 *
 *  ASCII output — everything that actually reaches this size in practice — is untouched by the bound:
 *  2 000 characters plus the notice is ~2.3 kB, so those placeholders are byte-identical to what the
 *  previous renderer produced. */
export function spillPreview(text: string, spillPath: string, originalBytes: number): string {
  let preview = text.slice(0, SPILL_PREVIEW_CHARS);
  while (preview.length > 0
    && Buffer.byteLength(clearedToolResultPlaceholder(spillPath, originalBytes, preview), 'utf8') >= CLEAR_MIN_BYTES) {
    preview = preview.slice(0, preview.length - Math.max(1, Math.ceil(preview.length / 8)));
  }
  return preview;
}

type ToolResultMessage = Extract<PiAgentMessage, { role: 'toolResult' }>;
type ContentBlock = ToolResultMessage['content'][number];

/** The content a cleared tool result carries: the placeholder in place of ALL of its text, followed by
 *  every block that is not text, in their original order.
 *
 *  Clearing is a decision about TEXT — the spill file holds text, the byte budgets measure text, and the
 *  placeholder names a path to read text back. An image block is none of those things: it has no
 *  representation in the spill file, so replacing the whole content with the placeholder would destroy
 *  the picture rather than move it. At delivery it would be destroyed before it was ever persisted, since
 *  the row is written from the message this content becomes.
 *
 *  Non-text blocks are therefore carried through untouched, and the image path that already exists keeps
 *  working on them: the projector externalizes the bytes to a `ref` on the way into the row, and the cold
 *  turn-start pass collapses them to the history placeholder once the cache is provably gone. One rule,
 *  used by the delivery trigger, the cold pass and the row rewrite alike, so all three agree on what a
 *  cleared result looks like. */
export function clearedToolResultContent<T extends { type: string }>(
  content: readonly T[],
  placeholder: string,
): ({ type: 'text'; text: string } | T)[] {
  return [
    { type: 'text' as const, text: placeholder },
    ...content.filter((block) => block.type !== 'text'),
  ];
}

/** The exact text a spill file holds for a result: its text blocks joined by '\n'. Single source of truth
 *  for what the cold pass writes and for the byte-identity check that adopts an existing file at the same
 *  path — if the two ever disagreed, a second pass would refuse every adoption and clear nothing. */
export function toolResultText(message: ToolResultMessage): string {
  return (Array.isArray(message.content) ? message.content : [])
    .filter((block: ContentBlock): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function textBytes(message: ToolResultMessage): number {
  if (!Array.isArray(message.content)) return 0;
  let total = 0;
  for (const block of message.content) {
    if (block.type === 'text') total += Buffer.byteLength(block.text, 'utf8');
  }
  return total;
}

/** Index of the user message that starts the KEEP_USER_TURNS-th turn from the end, or -1 when the
 *  conversation is shorter. Messages before it are eligible for clearing. Exported for tests. */
export function clearingCutIndex(
  messages: readonly PiAgentMessage[],
  keepUserTurns = KEEP_USER_TURNS,
): number {
  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (!isUserTurn(messages[index])) continue;
    seen += 1;
    if (seen === keepUserTurns) return index;
  }
  return -1;
}

export interface ClearableResult {
  index: number;
  toolCallId: string;
  /** The message's own timestamp, the second half of the identity a stored row is matched on: an id is
   *  not unique on its own, because sequential styles (`call_0`) reset every turn and a compaction can
   *  let the same id come back on a completely different result. 0 when the message carries none. */
  occurredAt: number;
  bytes: number;
}

/** Pure selection: which tool results may be cleared. Eligible = toolResult before the cut,
 *  ≥ {@link COLD_CLEAR_MIN_BYTES} of text, with a toolCallId (no id → no spill path → never cleared) and
 *  not already cleared ({@link isClearedToolResult}). Exported for tests.
 *
 *  A delivery-time preview placeholder is larger than this floor and is skipped by the structural marker
 *  alone — which is exactly what that marker exists for, and what stops a placeholder being nested inside
 *  a second one. */
export function selectClearableToolResults(
  messages: PiAgentMessage[],
  keepUserTurns = KEEP_USER_TURNS,
  minBytes = COLD_CLEAR_MIN_BYTES,
): ClearableResult[] {
  const cut = clearingCutIndex(messages, keepUserTurns);
  if (cut <= 0) return [];
  const selection: ClearableResult[] = [];
  for (let index = 0; index < cut; index += 1) {
    const message = messages[index];
    if (message?.role !== 'toolResult') continue;
    if (!message.toolCallId || isClearedToolResult(message)) continue;
    const bytes = textBytes(message);
    if (bytes < minBytes) continue;
    selection.push({ index, toolCallId: message.toolCallId, occurredAt: messageOccurredAt(message), bytes });
  }
  return selection;
}

/** The aggregate budget in force right now, floored at the operator-tunable per-result threshold: a
 *  result the per-result layer deliberately keeps inline must not be spilled by the aggregate layer
 *  merely for being alone in its group. Both knobs move independently, so the floor is applied here at
 *  the point of use rather than trusted to hold in whatever was stored. */
function groupBudgetBytes(): number {
  return Math.max(toolResultGroupBudget(), spillMaxResultBytes());
}

export async function defaultWriteSpill(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, { flag: 'wx' });
}

export async function defaultReadSpill(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch { return null; }
}

/* ── Delivery-time spilling (size + group) ─────────────────────────────────────────────────────── */

/** PI's `afterToolCall` hook, its input, and the content array it may replace — derived off the
 *  AgentSession surface for the same reason the transform types are: pi-agent-core is not a direct
 *  dependency of this package. */
type AfterToolCall = NonNullable<AgentSession['agent']['afterToolCall']>;
type AfterToolCallInput = Parameters<AfterToolCall>[0];
type DeliveryContent = NonNullable<NonNullable<Awaited<ReturnType<AfterToolCall>>>['content']>;

/** The text a spill file holds for a result that does not exist as a message yet: its text blocks joined
 *  by '\n', exactly as {@link toolResultText} joins them once it does. */
function deliveryText(content: readonly DeliveryContent[number][]): string {
  return content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
}

function deliveryBytes(content: readonly DeliveryContent[number][]): number {
  let total = 0;
  for (const block of content) {
    if (block.type === 'text') total += Buffer.byteLength(block.text, 'utf8');
  }
  return total;
}

/** What one result contributes to its wire-level group, and the spill it needs first (or none). */
export interface DeliverySpillDecision {
  /** Bytes this result will add to the group once the decision holds — the placeholder's when it is
   *  spilled, the output's when it is not. The caller commits this only after the spill has succeeded. */
  wireBytes: number;
  spill: {
    trigger: Extract<SpillTrigger, 'size' | 'group'>;
    path: string;
    text: string;
    placeholder: string;
    marker: ClearedToolResultMarker;
    /** The original output's size, the number the placeholder quotes. */
    bytes: number;
  } | null;
}

/** Decide, at DELIVERY, whether one tool result reaches the model at all — the size trigger and the
 *  aggregate group trigger in one pure function.
 *
 *  Deciding here rather than at egress is the whole point of this path: the placeholder exists BEFORE
 *  `createToolResultMessage` builds the message, so the pending row, the agent state, the SessionManager
 *  entry, the `tool_execution_end` UI event and the `agent_end` re-persist all carry it without a single
 *  rewrite. The content has never been sent, so replacing it APPENDS a smaller block to the cached prefix
 *  instead of rewriting one — the cache invariant holds by construction rather than by a gate.
 *
 *  `committedBytes` is what this result's wire-level group (one assistant message's batch of tool calls,
 *  which pi-ai's converter coalesces into a single user message) has already committed. The group rule is
 *  therefore ONLINE and irrevocable: a result is spilled when admitting it whole would take the group past
 *  the budget. There is deliberately no lower size bound on that decision — with one, a group of many
 *  small results would have no eligible candidate and could overrun the budget without limit.
 *
 *  The resulting guarantee is `group ≤ budget + n·placeholder`, where the placeholder is bounded under
 *  {@link CLEAR_MIN_BYTES} by construction ({@link spillPreview}). It is an INDUCTION over the results of
 *  one batch and therefore holds only while the decisions are taken one at a time, which the caller
 *  guarantees by serializing them per batch — PI finalizes a batch in parallel, and concurrent decisions
 *  each spend a budget the others have already spent. It counts TEXT bytes: an image block is neither
 *  measured nor spilled here. What it does NOT reproduce is the
 *  egress pass's largest-first choice: the results of one batch are finalized in completion order and
 *  each decision is final by the time the next result arrives, so an early large result can fill the
 *  budget that a later, larger one would have used better. Both orders honour the budget; only the
 *  ordering differs, and the cold-start pass clears whatever the online order left behind. */
export function decideDeliverySpill(
  committedBytes: number,
  spillDir: string,
  toolCallId: string,
  content: readonly DeliveryContent[number][],
): DeliverySpillDecision {
  const bytes = deliveryBytes(content);
  const oversized = bytes > spillMaxResultBytes();
  const overBudget = committedBytes + bytes > groupBudgetBytes();
  // No id means no spill path (pathGuard could not let the model read it back), so such a result can
  // only ever be counted toward its group, never removed from it. No TEXT means there is nothing a spill
  // could hold: a pure image result past an already-spent budget would otherwise be handed a placeholder
  // naming an empty file, which costs the group more than the zero bytes it charges it for.
  if (!toolCallId || bytes === 0 || (!oversized && !overBudget)) return { wireBytes: bytes, spill: null };
  const path = toolResultSpillPath(spillDir, toolCallId, { mode: 'preview', bytes });
  const text = deliveryText(content);
  const placeholder = clearedToolResultPlaceholder(path, bytes, spillPreview(text, path, bytes));
  return {
    wireBytes: Buffer.byteLength(placeholder, 'utf8'),
    spill: {
      trigger: oversized ? 'size' : 'group',
      path, text, placeholder,
      marker: { mode: 'preview', bytes, path },
      bytes,
    },
  };
}

export interface ToolResultDeliverySpillOptions {
  /** Directory the spill files land in; defaults to the session's resolved spill dir. */
  spillDir?: string;
  /** Spill writer injection for tests. Receives the absolute path and the full text. */
  writeSpill?: (path: string, text: string) => Promise<void>;
  /** Spill reader injection for tests; null = unreadable/missing. Used to verify an EEXIST survivor. */
  readSpill?: (path: string) => Promise<string | null>;
}

/** The live Sandbox provider for a MANAGED-project turn's spills — the same bootstrap seam pattern as
 *  `setSpillMaxResultBytes` above: injected once at process construction (buildBrainCore, where
 *  `control('sandbox')` is already resolved for the other consumers), `undefined` (tests, un-wired
 *  processes) means managed turns REFUSE (the result is preserved whole, never host-spilled); host
 *  turns are unaffected.
 *
 *  A provider resolved per OPERATION, never cached: the delivery hook runs inside a live turn, so the
 *  provider must be the one the plugin currently publishes. UNWIRED does NOT mean host-spill fallback:
 *  on a managed turn the result is preserved whole with an error log; only a non-managed turn takes
 *  the host path. */
let managedSandboxResolver: SandboxResolver | undefined;
export function setManagedSandboxResolver(resolve: SandboxResolver | undefined): void {
  managedSandboxResolver = resolve;
}

/** The seam's current state, for the sibling central consumer (the cold turn-start pass) that shares the
 *  same bootstrap wiring rather than threading its own. */
export function managedSandboxSeam(): SandboxResolver | undefined {
  return managedSandboxResolver;
}

/** Compose the delivery-time spill onto the session's `afterToolCall`, wrapping whatever is already
 *  there (the extension `tool_result` hooks and image normalization PI installs) the same way the
 *  `transformContext` installers wrap each other.
 *
 *  The added work is wrapped in try/catch and NOTHING escapes it. PI treats a throwing `afterToolCall`
 *  as a failed tool call and replaces the whole result with an error string, so a single ENOSPC on the
 *  spill would not merely leave the output unspilled — it would destroy it. Every failure path here
 *  returns the inner hook's result untouched, which sends the full output to the model. A throw from the
 *  INNER hook is deliberately left to propagate: that is PI's existing contract for those hooks and not
 *  this module's to change.
 *
 *  Two tool-result paths bypass this hook entirely and are covered by the cold-start pass alone: PI's
 *  `immediate` preparations (tool not found, invalid arguments, a blocked or aborted call) and the batch
 *  failed after a truncated assistant message. Every one of them is a short generated error string, so
 *  neither trigger would have fired on them anyway. */
export function installToolResultDeliverySpill(
  session: { agent?: { afterToolCall?: AfterToolCall } },
  sessionId: string,
  options: ToolResultDeliverySpillOptions = {},
): void {
  const agent = session.agent;
  if (!agent) return;
  const spillDir = options.spillDir ?? sessionToolResultSpillDir(process.env, sessionId);
  const writeSpill = options.writeSpill ?? defaultWriteSpill;
  const readSpill = options.readSpill ?? defaultReadSpill;
  /** Wire bytes already committed per batch. Keyed by the assistant message that requested the calls,
   *  which is exactly one wire-level tool-result message after pi-ai coalesces the run — and weakly, so
   *  a long conversation's batches are collected with their messages. */
  const committed = new WeakMap<object, number>();
  /** The tail of each batch's decision chain. PI finalizes a batch's tool calls with `Promise.all`, so
   *  without this every result of one batch reads the same `committed` value, awaits its own spill, and
   *  then writes a total that has forgotten every other result — the online budget an unserialized
   *  counter enforces is no bound at all (a measured 352 kB against a declared 232 kB).
   *
   *  Serializing the DECISION restores the model the budget is actually derived from: one result at a
   *  time, each seeing what the ones before it committed, which is what makes `group ≤ budget + n·placeholder`
   *  an induction rather than a hope. Only the decision is serialized — the tools themselves ran in
   *  parallel long before this hook, and the work between two links is one spill write. */
  const decisions = new WeakMap<object, Promise<unknown>>();
  const inner = agent.afterToolCall;
  agent.afterToolCall = async (input, signal) => {
    const hooked = await inner?.(input, signal);
    try {
      return await afterPreviousDecision(input, hooked);
    } catch (error) {
      log.warn(`delivery-time spill decision failed for ${input.toolCall?.id} — the result goes out whole`, error);
      return hooked;
    }
  };

  /** Queue this result's decision behind the ones already taken for its batch. The stored tail is always
   *  a SETTLED promise: a link that rejected must not take the rest of the batch down with it — those
   *  results would then never be decided at all, which is the one failure this module must never cause. */
  function afterPreviousDecision(
    input: AfterToolCallInput,
    hooked: Awaited<ReturnType<AfterToolCall>>,
  ): Promise<Awaited<ReturnType<AfterToolCall>>> {
    const batch = input.assistantMessage as unknown as object;
    const previous = decisions.get(batch) ?? Promise.resolve();
    const decision = previous.then(() => spillOnDelivery(input, hooked));
    decisions.set(batch, decision.then(() => undefined, () => undefined));
    return decision;
  }

  async function spillOnDelivery(
    input: AfterToolCallInput,
    hooked: Awaited<ReturnType<AfterToolCall>>,
  ): Promise<Awaited<ReturnType<AfterToolCall>>> {
    const content = hooked?.content ?? input.result.content ?? [];
    const batch = input.assistantMessage as unknown as object;
    const before = committed.get(batch) ?? 0;
    const initial = decideDeliverySpill(before, spillDir, input.toolCall.id, content);
    if (!initial.spill) {
      committed.set(batch, before + initial.wireBytes);
      return hooked;
    }
    // A managed turn spills into the MANAGED PROJECT (the placeholder names a guest path the model can
    // read; the host path it cannot). No host fallback: an absent/malformed/failing provider preserves
    // the result WHOLE and logs at error level — never a placeholder naming an unreadable host file.
    if (currentProjectRef()?.kind === 'managed') {
      if (typeof managedSandboxResolver !== 'function') {
        log.error(`managed tool-result spill for ${input.toolCall.id}: the Sandbox seam is not wired — the result is preserved whole and NOT spilled to the host path`);
        committed.set(batch, before + deliveryBytes(content));
        return hooked;
      }
      const sink = await managedSpillSink(input.toolCall.id);
      if (!sink) {
        committed.set(batch, before + deliveryBytes(content));
        return hooked;
      }
      const decision = decideDeliverySpill(before, sink.dir, input.toolCall.id, content);
      if (!decision.spill) {
        committed.set(batch, before + decision.wireBytes);
        return hooked;
      }
      const { trigger, path, text, placeholder, marker, bytes } = decision.spill;
      if (!await sink.store(path, text, input.toolCall.id)) {
        committed.set(batch, before + deliveryBytes(content));
        return hooked;
      }
      committed.set(batch, before + decision.wireBytes);
      log.info(`spilled ${input.toolCall.id} on delivery (${trigger} trigger, ${bytes} bytes, managed)`);
      return {
        ...hooked,
        content: clearedToolResultContent(content, placeholder) as DeliveryContent,
        details: clearedToolResultDetails(hooked?.details ?? input.result.details, marker),
      };
    }
    const decision = initial;
    if (!decision.spill) {
      committed.set(batch, before + decision.wireBytes);
      return hooked;
    }
    const { trigger, path, text, placeholder, marker, bytes } = decision.spill;
    if (!await storeSpill(path, text, input.toolCall.id)) {
      // The output could not be stored, so it must go out whole — a placeholder naming a file that does
      // not exist would lose it. It costs its full size against the group, which is the honest number.
      committed.set(batch, before + deliveryBytes(content));
      return hooked;
    }
    committed.set(batch, before + decision.wireBytes);
    // The one line that lets a cacheWatch warning be attributed to this module rather than to image
    // stripping — the two rewrite different things and have completely different fixes.
    log.info(`spilled ${input.toolCall.id} on delivery (${trigger} trigger, ${bytes} bytes)`);
    return {
      ...hooked,
      content: clearedToolResultContent(content, placeholder) as DeliveryContent,
      details: clearedToolResultDetails(hooked?.details ?? input.result.details, marker),
    };
  }

  /** The guest spill sink for one managed delivery: the session's guest spill directory (same immutable
   *  namespace as the host dir), a create-once CAS write with EEXIST adoption. Spills larger than one
   *  guest write op cannot be stored (no append in the contract) — the store answers false and the
   *  result goes out whole. */
  async function managedSpillSink(
    toolCallId: string,
  ): Promise<{ dir: string; store: (path: string, text: string, id: string) => Promise<boolean> } | null> {
    const resolved = await resolveManagedArtifactTurn(managedSandboxResolver);
    if (typeof resolved === 'string') {
      log.error(`managed tool-result spill unavailable for ${toolCallId}: ${resolved} — the result is preserved whole and NOT spilled to the host path`);
      return null;
    }
    const guest = {
      sandbox: resolved.sandbox,
      projectRef: resolved.turn.projectRef,
      accountUserId: resolved.turn.accountUserId,
    };
    const dir = guestSpillDirForNamespace(sessionToolResultSpillNamespace(sessionId));
    return {
      dir,
      store: async (path, body, id) => {
        if (Buffer.byteLength(body, 'utf8') > GUEST_WRITE_OP_BYTES) {
          log.warn(`managed tool-result spill for ${id} exceeds the ${GUEST_WRITE_OP_BYTES / 1024} KiB guest write limit — the result goes out whole`);
          return false;
        }
        const guestPath = guestArtifactDestinationPath(path);
        if (!guestPath || !guestPath.startsWith(`${dir}/`)) return false;
        const written = await writeGuestFile(guest, guestPath, Buffer.from(body, 'utf8'));
        if (typeof written !== 'string') return true;
        // A file already at the spill path: adopt an identical survivor (a toolCallId is not unique on
        // its own — see storeSpill below), refuse anything else. Same reconciliation, guest-side.
        const onDisk = await readGuestFileBounded(guest, guestPath, GUEST_WRITE_OP_BYTES);
        if (typeof onDisk !== 'string' && onDisk.equals(Buffer.from(body, 'utf8'))) return true;
        log.warn(`managed tool-result spill for ${id} conflicts with a different guest file — the result goes out whole: ${written}`);
        return false;
      },
    };
  }

  /** Write the spill write-once, adopting an identical file already at the path. Same reconciliation as
   *  {@link persistToolOutputSpill}: a toolCallId is not unique on its own, so a later call can land on
   *  an existing name, and overwriting would swap the content under a path an earlier placeholder still
   *  tells the model to read. Returns whether the path now holds this text. */
  async function storeSpill(path: string, text: string, toolCallId: string): Promise<boolean> {
    try {
      await writeSpill(path, text);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        log.warn(`tool result spill failed for ${toolCallId} — leaving the result in context`, error);
        return false;
      }
      const onDisk = await readSpill(path).catch(() => null);
      if (onDisk === text) return true;
      log.warn(`tool result spill for ${toolCallId} conflicts with a different file on disk — leaving the result in context`);
      return false;
    }
  }
}
