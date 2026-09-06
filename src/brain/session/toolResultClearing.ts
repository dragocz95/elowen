import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { fsSafeSegment, sessionToolResultSpillDir } from '../../shared/paths.js';
import { logger } from '../../shared/logger.js';
import type { PiAgentMessage } from './historyImageStripping.js';
import { cacheColdAtTurnStart, cacheTtlMs, idleThresholdMs } from './cacheTiming.js';
import { isUserTurn } from './userTurn.js';

export { cacheColdAtTurnStart, cacheTtlMs, idleThresholdMs };

/** Egress-only clearing of large historical tool results — the transferable core of Claude Code's
 *  time-based microcompact, adapted to Elowen's `transformContext` seam (the same hook
 *  `historyImageStripping` composes onto). Anthropic's prompt cache is prefix-based, so the one rule
 *  that matters is: NEVER rewrite history while the cache could still be warm. Two mechanisms enforce
 *  it:
 *
 *  1. The gate opens only when the turn's first user message arrived MORE than the cache TTL after the
 *     previous message — i.e. the cached prefix had already expired and this provider call pays a full
 *     re-cache either way. Clearing here SHRINKS that rewrite instead of costing anything.
 *  2. A per-session latch (Map of cleared occurrences → their placeholder) guarantees a result once
 *     cleared stays cleared on every later request, so the prefix is byte-stable from then on. The
 *     latch is keyed by OCCURRENCE ({@link toolResultOccurrenceKey}), never by toolCallId alone:
 *     sequential id styles (`call_0`) reset per turn, so after a compaction removes the cleared
 *     occurrence the same id can genuinely come back on a brand-new result — an id-keyed latch would
 *     swallow that fresh result and hand the model a placeholder pointing at another call's spill.
 *     The latch lives in this closure, so a respawn starts empty — and the cache is server-side, so a
 *     respawn WITHIN the TTL is NOT cold: re-sending the full results would rewrite a warm prefix and
 *     pay a full re-cache. `restoreLatch` therefore rebuilds it on the first pass: primarily from the
 *     rows this module writes to SQLite as it clears (`ToolResultLatchStore` → brain_tool_result_spills),
 *     falling back to the spill FILES for sessions cleared before that table existed. The fallback needs
 *     the original byte counts, which is why they live in the file NAME — the placeholder embeds them
 *     and they cannot be measured back off the file (see `toolResultSpillPath`).
 *
 *  The full text is spilled to `<dataDir>/tool-results/<spillNs>/<toolCallId>.v1-<mode>-<bytes>.txt` BEFORE the
 *  placeholder replaces it (write-once, `wx`), so clearing loses nothing the model could not re-read
 *  with the Read tool — pathGuard lets every session read its OWN spill dir. Persisted history in
 *  the store is untouched — this runs on PI's egress copy.
 *
 *  A SECOND trigger shares all of that machinery: a single result bigger than SPILL_MAX_RESULT_BYTES
 *  is spilled on SIZE at delivery, whatever the idle gate says (Claude Code's
 *  DEFAULT_MAX_RESULT_SIZE_CHARS behaves the same way). It is restricted to the current run — the
 *  results produced after the last user message — because those have not been sent to the provider
 *  yet: replacing one there APPENDS a smaller block to the prefix instead of rewriting a cached one,
 *  so rule 1 still holds. Everything older stays the time gate's business. That boundary survives a
 *  respawn as well — not because `settlePartialTurn` inserts anything (it does not), but because a
 *  provider request only ever happens inside a prompt, and a respawned session is always prompted with
 *  a FRESH user message appended after its rehydrated history: results settled from a crashed turn sit
 *  before that message, in the time gate's region, where this process's empty per-run decision sets
 *  (`budgetDecided`, `failedSpills`) can never re-judge them. Because the model never
 *  gets to see such a result at all, this placeholder also carries a preview of the content; the
 *  time-triggered one does not, since the model already read that result earlier in the conversation.
 *
 *  A THIRD trigger measures what the per-result one structurally cannot: the SUM of one wire-level
 *  tool-result message (see TOOL_RESULT_GROUP_BUDGET_BYTES). It runs on the same current-run region and
 *  the same spill machinery, spilling the largest members of an over-budget group until it fits, and it
 *  latches BOTH outcomes — spilled and kept — because a member left in place has by then gone out whole. */

const log = logger('brain-tool-clearing');

/** Which of the three triggers cleared a result. Only ever used to name the cause in the log — a
 *  cacheWatch warning names the message index, and this names who rewrote it. */
type SpillTrigger = 'time' | 'size' | 'group';

/** Results smaller than this stay in context: clearing them saves a handful of tokens while costing a
 *  spill file and a placeholder. 4 KB ≈ 1k tokens. */
export const CLEAR_MIN_BYTES = 4096;

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
const KEEP_USER_TURNS = 2;

/** Identity of ONE toolResult occurrence in the history: the model-minted id PLUS the message's own
 *  timestamp. The id alone is not an identity — sequential styles (`call_0`) reset every turn on some
 *  models, and after a compaction removes a cleared occurrence the same id can return on a completely
 *  different result. The timestamp is stamped by pi-ai when the result is created and survives both
 *  persistence and rehydration (the store keeps the full message JSON), which is what makes the pair
 *  stable across respawns. 0 stands in for a message with no usable timestamp — such occurrences fall
 *  back to sharing one key per id, i.e. exactly the pre-occurrence behaviour. */
export function toolResultOccurrenceKey(toolCallId: string, occurredAt: number): string {
  return `${toolCallId}\u0000${occurredAt}`;
}

/** A message's occurrence timestamp, defensively: pi-ai stamps every toolResult, but a rehydrated row
 *  from an old enough build may predate that, and a hook upstream could hand anything through. */
function messageOccurredAt(message: ToolResultMessage): number {
  const at = (message as { timestamp?: unknown }).timestamp;
  return typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : 0;
}

/** How far past a legacy latch row's own write time an occurrence may be stamped and still be treated
 *  as the occurrence that row was written for. A size/group spill writes its row within seconds of the
 *  result being minted, and a time spill only ever clears results that are already old — while a REUSED
 *  id is minted after a compaction that itself happened after the row existed, putting it well past
 *  this window. Only legacy rows (occurredAt 0, written before occurrence keying) need the heuristic;
 *  every new row carries the exact occurrence timestamp. */
const LEGACY_ROW_MATCH_SLACK_MS = 120_000;

/** Deterministic spill path — the placeholder builds it without any I/O, so the transform stays pure.
 *  The id is fs-encoded like the session id: a provider/plugin-minted toolCallId containing `/` or
 *  `..` must not escape the spill dir (pathGuard would refuse the escaped path and the cleared
 *  content would be unreadable). */
export function toolResultSpillPath(spillDir: string, toolCallId: string, descriptor: SpillDescriptor): string {
  return join(spillDir, `${fsSafeSegment(toolCallId)}.${SPILL_NAME_VERSION}-${descriptor.mode}-${descriptor.bytes}.txt`);
}

/** What a restored latch needs that the spill CONTENT cannot supply. `bytes` is the sum of the individual
 *  text blocks' byte lengths, while the file holds those blocks joined by '\n' — so for an n-block result
 *  the file is n-1 bytes larger and the number cannot be recovered by measuring it. `mode` decides which
 *  placeholder wording was used. Both are therefore carried in the FILE NAME, which makes the spill write
 *  a single atomic operation that persists content and metadata together: there is no window in which one
 *  exists without the other, and no second store to keep in sync.
 *
 *  Version prefix on purpose: the v1 rules include the preview length and the placeholder wording. A future
 *  change to either must mint v2 rather than reinterpret v1 names, because a restored latch has to rebuild
 *  the placeholder BYTE-IDENTICALLY or it defeats its own purpose. */
export interface SpillDescriptor { mode: 'time' | 'preview'; bytes: number }

const SPILL_NAME_VERSION = 'v1';

/** Name of a tool's COMPLETE output persisted by {@link persistToolOutputSpill}. Deliberately outside the
 *  `time|preview` grammar {@link parseSpillDescriptor} matches: this file is NOT the spill of the result
 *  the model received — the result carries an excerpt — so a restore pass must never offer it as a latch
 *  candidate for that result. Everything else (directory, fs-safe id encoding, version prefix, the byte
 *  count in the name) is the same, so there is one naming authority for this directory. */
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
 *  Write-once (`wx`) with the same EEXIST reconciliation the latch spills use, for the same reason: a
 *  toolCallId is not unique on its own (sequential `call_0` styles reset every turn — see
 *  {@link toolResultOccurrenceKey}), so a later call CAN land on an existing name, and only when its output
 *  is byte-identical in size at that. Overwriting would then swap the content under a path an earlier
 *  result still tells the model to read, with nothing marking the swap. Identical bytes are the same file
 *  and are simply adopted; a genuine conflict returns null, and the caller keeps whatever it does when
 *  nothing could be stored. */
export async function persistToolOutputSpill(
  spillDir: string,
  toolCallId: string,
  text: string,
): Promise<{ path: string; bytes: number } | null> {
  const bytes = Buffer.byteLength(text, 'utf8');
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

/** One durable latch entry — what a `latched` map entry looks like at rest. Written the moment a result
 *  is cleared and read back on the first pass after a respawn. The store is daemon-owned, so unlike the
 *  spill FILES these rows need no anti-spoof verification against the live message text — which is the
 *  point: the rehydrated text of a cleared result routinely DIFFERS from what was spilled (an
 *  externalized tool image comes back as a placeholder text block — persistence.ts
 *  `withoutExternalizedImages`), and a restore that insists on text equality forfeits exactly the
 *  results it matters for most. `placeholder` is the exact text already on the wire and is reproduced
 *  VERBATIM on restore — never re-rendered — so a later change to the placeholder wording can never
 *  silently rewrite bytes the provider has already cached. `path` is carried inside it and stored
 *  separately as well for observability. */
export interface PersistedToolResultLatch {
  toolCallId: string;
  /** The occurrence timestamp the latch belongs to ({@link toolResultOccurrenceKey}); 0 marks a legacy
   *  row written before occurrence keying, restored through the created-at heuristic instead. */
  occurredAt: number;
  mode: SpillDescriptor['mode'];
  bytes: number;
  /** The exact preview text the placeholder quotes; null for time-mode entries. */
  preview: string | null;
  path: string;
  /** The exact placeholder text already sent; null only on legacy rows, which fall back to the current
   *  renderer (whose output is what those rows' senders were running when they wrote them). */
  placeholder: string | null;
  /** When the row was written (SQLite UTC 'YYYY-MM-DD HH:MM:SS'). Supplied by load(); ignored on save —
   *  only the legacy-row restore heuristic reads it. */
  createdAt?: string;
}

/** Store seam for the durable latch — BrainStore in production (brain_tool_result_spills), fakes in
 *  tests. Functions rather than a store reference so this module keeps zero store dependencies.
 *  `remove` prunes a row whose occurrence no longer exists in the history (compacted away) — optional
 *  so an older adapter merely accumulates stale rows instead of breaking; the occurrence keying alone
 *  already keeps a stale row from ever matching a new result. */
export interface ToolResultLatchStore {
  load(): PersistedToolResultLatch[];
  save(entry: PersistedToolResultLatch): void;
  remove?(toolCallId: string, occurredAt: number): void;
}

/** Match the descriptor a spill name carries AFTER its (already known) encoded id. The id is never decoded
 *  back out of a file name: `fsSafeSegment` is injective but not cleanly reversible at its '%' edge cases,
 *  so restoration works FORWARD — encode the id from the live message, then look for that exact prefix. */
export function parseSpillDescriptor(fileName: string, encodedId: string): SpillDescriptor | null {
  const prefix = `${encodedId}.${SPILL_NAME_VERSION}-`;
  if (!fileName.startsWith(prefix)) return null;
  const match = /^(time|preview)-(\d+)\.txt$/.exec(fileName.slice(prefix.length));
  if (!match) return null;
  const bytes = Number(match[2]);
  if (!Number.isSafeInteger(bytes)) return null;
  return { mode: match[1] as SpillDescriptor['mode'], bytes };
}

/** The one placeholder shape both triggers use. With a preview the wording says the result was never
 *  put in the context (size trigger); without one it says an older result was cleared (time trigger).
 *  The preview follows the bracketed notice as plain text so the notice itself stays a single line.
 *  Only ever called when a result is FIRST cleared (and for legacy rows predating the persisted
 *  placeholder): a restored latch reproduces its stored placeholder verbatim, so editing this wording
 *  changes future clearings only and can never rewrite bytes already on the wire. */
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

type ToolResultMessage = Extract<PiAgentMessage, { role: 'toolResult' }>;
type ContentBlock = ToolResultMessage['content'][number];

/** The exact text a spill file holds for a result: its text blocks joined by '\n'. Single source of truth
 *  for the write and the restore comparison — if these two ever disagreed, no latch would ever restore. */
function toolResultText(message: ToolResultMessage): string {
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
export function clearingCutIndex(messages: readonly PiAgentMessage[]): number {
  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (!isUserTurn(messages[index])) continue;
    seen += 1;
    if (seen === KEEP_USER_TURNS) return index;
  }
  return -1;
}

export interface ClearableResult {
  index: number;
  toolCallId: string;
  /** Occurrence timestamp ({@link toolResultOccurrenceKey}); 0 when the message carries none. */
  occurredAt: number;
  bytes: number;
}

function occurrenceKeyOf(message: ToolResultMessage): string {
  return toolResultOccurrenceKey(message.toolCallId, messageOccurredAt(message));
}

/** Pure selection: which tool results may be cleared on this pass. Eligible = toolResult before the
 *  cut, ≥ CLEAR_MIN_BYTES of text, with a toolCallId (no id → no spill path → never cleared), not
 *  already latched. `alreadyCleared` holds occurrence keys, so a NEW result that merely reuses a
 *  latched id is judged on its own. Exported for tests. */
export function selectClearableToolResults(
  messages: PiAgentMessage[],
  alreadyCleared: ReadonlySet<string>,
): ClearableResult[] {
  const cut = clearingCutIndex(messages);
  if (cut <= 0) return [];
  const selection: ClearableResult[] = [];
  for (let index = 0; index < cut; index += 1) {
    const message = messages[index];
    if (message?.role !== 'toolResult') continue;
    if (!message.toolCallId || alreadyCleared.has(occurrenceKeyOf(message))) continue;
    const bytes = textBytes(message);
    if (bytes < CLEAR_MIN_BYTES) continue;
    selection.push({ index, toolCallId: message.toolCallId, occurredAt: messageOccurredAt(message), bytes });
  }
  return selection;
}

/** Index of the message that opened the current run, or -1 when the conversation has no user message
 *  yet. Everything after it was produced during this turn. */
function lastUserIndex(messages: readonly PiAgentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isUserTurn(messages[index])) return index;
  }
  return -1;
}

/** Pure selection for the size trigger: results of the CURRENT run (after the last user message) that
 *  are too large to hand to the model at all. Deliberately the complement of
 *  selectClearableToolResults' region — a result the provider has already seen must not be rewritten
 *  outside the idle gate, however big it is. Exported for tests. */
export function selectOversizedToolResults(
  messages: PiAgentMessage[],
  alreadyCleared: ReadonlySet<string>,
): ClearableResult[] {
  const selection: ClearableResult[] = [];
  for (let index = lastUserIndex(messages) + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== 'toolResult') continue;
    if (!message.toolCallId || alreadyCleared.has(occurrenceKeyOf(message))) continue;
    const bytes = textBytes(message);
    if (bytes <= spillMaxResultBytes()) continue;
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

/** Indices of each maximal run of consecutive toolResult messages in the CURRENT run — one run is one
 *  wire-level message, and the current run is the only region whose results have not reached the
 *  provider yet (same boundary, and the same cache reason, as selectOversizedToolResults). */
function currentRunToolResultGroups(messages: readonly PiAgentMessage[]): number[][] {
  const groups: number[][] = [];
  let group: number[] = [];
  for (let index = lastUserIndex(messages) + 1; index < messages.length; index += 1) {
    if (messages[index]?.role === 'toolResult') { group.push(index); continue; }
    if (group.length > 0) { groups.push(group); group = []; }
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

export interface BudgetedSelection {
  /** Results to spill, largest first — spilling them in this order brings each group back under budget. */
  spill: ClearableResult[];
  /** Occurrence keys of every candidate the budget layer weighed this pass, spilled or not. The caller
   *  latches these: a result that has once been handed to the provider whole must never be reconsidered,
   *  or a later pass (after a failed spill, or after a Limits change) would rewrite a prefix the
   *  provider already cached. */
  decided: string[];
}

/** Pure selection for the aggregate trigger: per wire-level group, spill the largest members until the
 *  group's total is back under budget. `spilled` members already reach the provider as a placeholder, so
 *  they cost the group nothing; `kept` members are latched decisions and count at full size without ever
 *  becoming candidates again. Both sets hold occurrence keys. A member without a toolCallId has no spill
 *  path, so it can only ever be weighed, never spilled. Exported for tests. */
export function selectBudgetedToolResults(
  messages: PiAgentMessage[],
  spilled: ReadonlySet<string>,
  kept: ReadonlySet<string>,
): BudgetedSelection {
  const budget = groupBudgetBytes();
  const selection: BudgetedSelection = { spill: [], decided: [] };
  for (const group of currentRunToolResultGroups(messages)) {
    let total = 0;
    const candidates: ClearableResult[] = [];
    for (const index of group) {
      const message = messages[index] as ToolResultMessage;
      const key = message.toolCallId ? occurrenceKeyOf(message) : '';
      if (message.toolCallId && spilled.has(key)) continue;
      const bytes = textBytes(message);
      total += bytes;
      if (!message.toolCallId || kept.has(key)) continue;
      candidates.push({ index, toolCallId: message.toolCallId, occurredAt: messageOccurredAt(message), bytes });
    }
    candidates.sort((a, b) => (b.bytes - a.bytes) || (a.index - b.index));
    for (const candidate of candidates) {
      if (total <= budget) break;
      selection.spill.push(candidate);
      total -= candidate.bytes;
    }
    for (const candidate of candidates) {
      selection.decided.push(toolResultOccurrenceKey(candidate.toolCallId, candidate.occurredAt));
    }
  }
  return selection;
}

/** Pure replacement: swap each indexed message's content for its placeholder text block. Input is
 *  never mutated and unselected messages keep their references (idempotence, same contract as
 *  stripHistoricalImages). Keyed by INDEX because the caller has already resolved WHICH occurrence of
 *  each latched id carries the placeholder — this function must not re-guess. Exported for tests. */
export function applyToolResultClearing(
  messages: PiAgentMessage[],
  cleared: ReadonlyMap<number, string>,
): PiAgentMessage[] {
  let changed = false;
  const next = messages.map((message, index): PiAgentMessage => {
    if (message?.role !== 'toolResult') return message;
    const placeholder = cleared.get(index);
    if (placeholder === undefined) return message;
    const already = Array.isArray(message.content)
      && message.content.length === 1
      && message.content[0]?.type === 'text'
      && message.content[0].text === placeholder;
    if (already) return message;
    changed = true;
    return { ...message, content: [{ type: 'text', text: placeholder }] };
  });
  return changed ? next : messages;
}

export interface ToolResultClearingOptions {
  /** Directory the spill files land in; defaults to the session's resolved spill dir
   *  ({@link sessionToolResultSpillDir} — the immutable spill namespace when the resolver is wired). */
  spillDir?: string;
  /** Idle gate in ms; defaults to idleThresholdMs(process.env). */
  idleMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
  /** Spill writer injection for tests. Receives the absolute path and the full text. */
  writeSpill?: (path: string, text: string) => Promise<void>;
  /** Spill reader injection for tests; null = unreadable/missing. Used to verify an EEXIST survivor. */
  readSpill?: (path: string) => Promise<string | null>;
  /** Spill directory listing injection for tests. Missing directory = empty list, never a throw. */
  listSpill?: (dir: string) => Promise<string[]>;
  /** Durable latch storage. Omitted (tests, un-wired paths) the latch is file-restored only, which
   *  cannot survive a text drift between spill and rehydration — see {@link PersistedToolResultLatch}. */
  latchStore?: ToolResultLatchStore;
}

async function defaultWriteSpill(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, { flag: 'wx' });
}

async function defaultReadSpill(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch { return null; }
}

async function defaultListSpill(dir: string): Promise<string[]> {
  try { return await readdir(dir); }
  catch { return []; } // no spill dir yet is the normal case for a fresh session
}

/** A row's SQLite UTC 'YYYY-MM-DD HH:MM:SS' as epoch ms; 0 when missing or unparsable — which makes the
 *  legacy-row heuristic match only timestamp-less occurrences, the conservative reading (a wrong match
 *  is data corruption, a missed one is a single re-cache). */
function parseSqliteUtcMs(value: string | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value.includes('T') || value.includes('Z') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : 0;
}

/** What one latched occurrence carries in memory. `placeholder` is built exactly once — at spill time or
 *  read back from the durable row — and reproduced verbatim on every later pass. */
interface LatchEntry {
  toolCallId: string;
  occurredAt: number;
  bytes: number;
  preview?: string;
  path: string;
  placeholder: string;
}

/** Compose the clearing pass onto the session's `transformContext`, after (inside) any previous hook —
 *  installed after installHistoryImageStripping so it sees images already collapsed. Same wrap pattern
 *  as the other installers; a session without the agent seam is a no-op. */
export function installToolResultClearing(
  session: { agent?: { transformContext?: NonNullable<AgentSession['agent']['transformContext']> } },
  sessionId: string,
  options: ToolResultClearingOptions = {},
): void {
  const agent = session.agent;
  if (!agent) return;
  const spillDir = options.spillDir ?? sessionToolResultSpillDir(process.env, sessionId);
  const idleMs = options.idleMs ?? idleThresholdMs(process.env);
  const now = options.now ?? Date.now;
  const writeSpill = options.writeSpill ?? defaultWriteSpill;
  const readSpill = options.readSpill ?? defaultReadSpill;
  const listSpill = options.listSpill ?? defaultListSpill;
  const latchStore = options.latchStore;
  /** Cleared occurrence key → its latch entry. The latch is what makes the egress prefix byte-stable
   *  across requests: once inside, the placeholder never reverts to full content — and re-sending the
   *  same stored placeholder every pass is what keeps those bytes identical. Keyed by occurrence, so a
   *  fresh result that reuses a latched toolCallId (sequential id styles after a compaction) is never
   *  captured by another occurrence's entry. */
  const latched = new Map<string, LatchEntry>();
  /** Mirror one latch entry into the durable store. Best-effort by design: the in-memory latch already
   *  holds, so this turn stays byte-stable either way — a failure only means a respawn before a later
   *  successful save falls back to the file-equality restore, i.e. exactly the pre-table behaviour. */
  const persistLatch = (entry: LatchEntry): void => {
    if (!latchStore) return;
    try {
      latchStore.save({
        toolCallId: entry.toolCallId,
        occurredAt: entry.occurredAt,
        mode: entry.preview === undefined ? 'time' : 'preview',
        bytes: entry.bytes,
        preview: entry.preview ?? null,
        path: entry.path,
        placeholder: entry.placeholder,
      });
    } catch (error) {
      log.warn(`failed to persist the latch for ${entry.toolCallId} — it may not survive a respawn`, error);
    }
  };
  /** Drop a durable row whose occurrence is gone. Same best-effort stance as persistLatch, and a no-op
   *  through an adapter that predates `remove` — stale rows then merely accumulate, they never match. */
  const removeLatch = (toolCallId: string, occurredAt: number): void => {
    if (!latchStore?.remove) return;
    try { latchStore.remove(toolCallId, occurredAt); }
    catch (error) { log.warn(`failed to prune the stale latch row for ${toolCallId}`, error); }
  };
  /** Occurrence keys seen more than once in one history — with occurrence keying this means two results
   *  sharing BOTH id and timestamp, a genuine protocol anomaly worth exactly one log line, not one per
   *  pass. */
  const duplicateWarned = new Set<string>();
  /** Restoration runs once, on the first pass, and only matters after a RESPAWN: the latch lives in this
   *  closure, so a restart leaves it empty while the persisted history still holds the results in full.
   *  Sending them whole again is what makes the first request of a warm conversation pay a full re-cache
   *  ($3.04 measured, against ~$0.12 for a normal turn). Doing it here rather than at construction time
   *  is deliberate — this is the first moment the post-hook message text exists to verify against. */
  let restored = false;
  /** Occurrence keys whose spill failed during THIS idle epoch. The gate stays open for a whole turn, so
   *  retrying on the next pass would clear right after THIS pass paid a full re-cache — a warm-prefix
   *  rewrite, the one thing this module must never do. Retries wait for the next gate OPENING. */
  const failedSpills = new Set<string>();
  /** Occurrence keys whose spill path is occupied by a DIFFERENT file. `wx` can never overwrite it, so
   *  retrying could only ever warn again — skip permanently (for this session's lifetime). */
  const foreignSpills = new Set<string>();
  /** Occurrence keys the aggregate budget has already ruled on. The second half of the latch: a member
   *  left in place goes to the provider whole, so re-weighing its group later — after a failed spill, or
   *  after the threshold moved — could pick a DIFFERENT member and rewrite a prefix that is already
   *  cached. A ruling stands for the session; the time trigger may still clear such a result once the
   *  gate is cold, which is the only moment rewriting history is free. */
  const budgetDecided = new Set<string>();
  let gateWasOpen = false;
  const previous = agent.transformContext;
  /** Restore one legacy row (occurredAt 0 — written before occurrence keying) by finding the occurrence
   *  it was written for. Only occurrences stamped BEFORE the row was written (plus slack) qualify: a
   *  newer one is a REUSED id minted after a compaction removed the original, and matching it is exactly
   *  the deployed defect this keying exists to end — the fresh result would go out as a stale
   *  placeholder pointing at another call's spill. Among the qualifiers the byte-exact one wins (it is
   *  the one that was spilled); text drift (externalized images) falls back to the first. No qualifier
   *  at all means the occurrence was compacted away, so the row is pruned rather than left to ambush a
   *  future reuse of the id. */
  const restoreLegacyRow = (row: PersistedToolResultLatch, base: readonly PiAgentMessage[]): void => {
    const rowWrittenMs = parseSqliteUtcMs(row.createdAt);
    let byteExact: ToolResultMessage | undefined;
    let first: ToolResultMessage | undefined;
    for (const message of base) {
      if (message?.role !== 'toolResult') continue;
      const candidate = message as ToolResultMessage;
      if (candidate.toolCallId !== row.toolCallId) continue;
      const at = messageOccurredAt(candidate);
      if (at > rowWrittenMs + LEGACY_ROW_MATCH_SLACK_MS) continue;
      if (latched.has(occurrenceKeyOf(candidate))) continue;
      if (textBytes(candidate) === row.bytes) { byteExact = candidate; break; }
      first ??= candidate;
    }
    const target = byteExact ?? first;
    if (!target) {
      removeLatch(row.toolCallId, 0);
      return;
    }
    const occurredAt = messageOccurredAt(target);
    const preview = row.mode === 'preview' ? row.preview ?? '' : undefined;
    const entry: LatchEntry = {
      toolCallId: row.toolCallId,
      occurredAt,
      bytes: row.bytes,
      ...(preview === undefined ? {} : { preview }),
      path: row.path,
      // A legacy row predates the persisted placeholder; the current renderer is what its writer ran.
      placeholder: row.placeholder ?? clearedToolResultPlaceholder(row.path, row.bytes, preview),
    };
    latched.set(toolResultOccurrenceKey(entry.toolCallId, entry.occurredAt), entry);
    // Graduate the row to its real occurrence key, then retire the legacy one — unless the occurrence
    // itself has no timestamp, in which case 0 IS its key and the upsert above already refreshed it.
    persistLatch(entry);
    if (occurredAt !== 0) removeLatch(row.toolCallId, 0);
  };
  /** Rebuild the latch a previous process built, so a respawned session keeps sending the placeholders
   *  it was already sending instead of the full results. Durable store rows first (exact, text-drift
   *  proof), then the spill files for anything from before the store existed.
   *
   *  The file path's verification is an ANTI-SPOOF check, not part of building the placeholder: a
   *  session may write into its own spill dir (pathGuard allows it), so a file could hold text that was
   *  never this tool's output. A time-mode placeholder needs only the path and the byte count, both of
   *  which come from the file NAME. Consequently a failed comparison costs one re-cache — the result
   *  simply is not latched — and can never produce a placeholder that misdescribes the output. The
   *  store rows need no such check: only the daemon writes them. */
  const restoreLatch = async (base: readonly PiAgentMessage[]): Promise<void> => {
    // The durable store is the primary source: it records exactly what was latched — the sent
    // placeholder verbatim — and restoring from it does not require the rehydrated message text to
    // still match the spill. The file-equality fallback below fails precisely when an upstream rewrite
    // changed that text (externalized images, historyImageStripping), and each such failure is a full
    // re-cache. Occurrence-keyed rows restore directly; rows whose occurrence a compaction has since
    // removed cannot match anything and are pruned on the first pass below.
    if (latchStore) {
      const rows = latchStore.load();
      for (const row of rows) {
        if (row.occurredAt === 0) continue; // legacy rows are matched against the history afterwards
        const key = toolResultOccurrenceKey(row.toolCallId, row.occurredAt);
        if (latched.has(key)) continue;
        const preview = row.mode === 'preview' ? row.preview ?? '' : undefined;
        latched.set(key, {
          toolCallId: row.toolCallId,
          occurredAt: row.occurredAt,
          bytes: row.bytes,
          ...(preview === undefined ? {} : { preview }),
          path: row.path,
          placeholder: row.placeholder ?? clearedToolResultPlaceholder(row.path, row.bytes, preview),
        });
      }
      // Second pass so a legacy row can never shadow an occurrence an exact row already owns.
      for (const row of rows) {
        if (row.occurredAt === 0) restoreLegacyRow(row, base);
      }
    }
    const names = await listSpill(spillDir);
    if (names.length === 0) return;
    for (const message of base) {
      if (message?.role !== 'toolResult') continue;
      const occurrence = message as ToolResultMessage;
      const toolCallId = occurrence.toolCallId;
      if (!toolCallId || latched.has(occurrenceKeyOf(occurrence))) continue;
      const encoded = fsSafeSegment(toolCallId);
      // Several spills can exist for one result: a restart whose restoration failed leaves the old file
      // behind and the cold gate then clears the same result again under a new name. Try them ALL rather
      // than picking one up front — a single guess that happens to land on the stale file would forfeit
      // the restoration even though a matching file sits right beside it.
      // Ordered so `time` is tried first: after such a cycle the live placeholder IS the time-mode one,
      // and both files hold identical content, so content equality alone cannot tell them apart.
      const candidates = names
        .map((name) => ({ name, descriptor: parseSpillDescriptor(name, encoded) }))
        .filter((c): c is { name: string; descriptor: SpillDescriptor } => c.descriptor !== null)
        .sort((a, b) => (a.descriptor.mode === b.descriptor.mode ? 0 : a.descriptor.mode === 'time' ? -1 : 1));
      if (candidates.length === 0) continue; // legacy `<id>.txt` spills land here and are left alone
      const text = toolResultText(occurrence);
      let restoredFrom: string | undefined;
      for (const candidate of candidates) {
        const path = join(spillDir, candidate.name);
        const onDisk = await readSpill(path);
        if (onDisk !== text) continue;
        // The preview is re-derived from the FILE rather than persisted separately, and this equality is
        // what makes that exact: the spill holds the same joined text the preview was sliced from. It also
        // removes the lone-surrogate hazard for free — a text whose UTF-16 was mangled by the write could
        // not have compared equal, so anything reaching this line round-trips faithfully.
        const preview = candidate.descriptor.mode === 'preview' ? onDisk.slice(0, SPILL_PREVIEW_CHARS) : undefined;
        const entry: LatchEntry = {
          toolCallId,
          occurredAt: messageOccurredAt(occurrence),
          bytes: candidate.descriptor.bytes,
          ...(preview === undefined ? {} : { preview }),
          path,
          placeholder: clearedToolResultPlaceholder(path, candidate.descriptor.bytes, preview),
        };
        latched.set(occurrenceKeyOf(occurrence), entry);
        // A file-restored entry graduates to the durable store, so the NEXT restart no longer depends
        // on the text still matching — the one-time migration path for pre-table spills.
        persistLatch(entry);
        restoredFrom = candidate.name;
        break;
      }
      if (restoredFrom === undefined) {
        // Worth a line: this is the difference between "restart was free" and "restart cost a full
        // re-cache". The usual cause is an earlier hook having rewritten the text since the spill — most
        // often historyImageStripping, whose own latch also dies with the process, so a result carrying an
        // image reads differently on a warm first pass than it did when it was spilled cold.
        log.warn(`no spill matches the current text of ${toolCallId} (${candidates.length} candidate(s)) — not restoring its latch`);
        continue;
      }
      log.info(`restored latch for ${toolCallId} from ${restoredFrom}`);
    }
  };
  agent.transformContext = async (messages, signal) => {
    const base = previous ? await previous(messages, signal) : messages;
    if (!restored) {
      // Restoration is an optimisation, never a precondition for answering: a failure here must cost a
      // re-cache, not the turn. Retried on the next pass, since a transient read failure that latched
      // nothing would otherwise leave the session paying full price for its whole life.
      try { await restoreLatch(base); restored = true; }
      catch (error) { log.warn('tool result latch restoration failed — results stay full for now', error); }
    }
    const gateOpen = cacheColdAtTurnStart(base, idleMs, now());
    if (gateOpen && !gateWasOpen) failedSpills.clear();
    gateWasOpen = gateOpen;
    /** Spill and latch a selection. Shared by both triggers, so a size-spilled result gets the same
     *  write-once semantics, the same EEXIST reconciliation and the same one-attempt-per-epoch retry
     *  rule. That rule matters just as much here: once a size spill has failed, the full result has
     *  gone out to the provider, so retrying it before the gate re-opens would rewrite a warm prefix. */
    const spillSelected = async (items: ClearableResult[], withPreview: boolean, trigger: SpillTrigger): Promise<void> => {
      for (const item of items) {
        const key = toolResultOccurrenceKey(item.toolCallId, item.occurredAt);
        if (failedSpills.has(key) || foreignSpills.has(key)) continue;
        const message = base[item.index] as ToolResultMessage;
        const text = toolResultText(message);
        const spillPath = toolResultSpillPath(spillDir, item.toolCallId, {
          mode: withPreview ? 'preview' : 'time',
          bytes: item.bytes,
        });
        const preview = withPreview ? text.slice(0, SPILL_PREVIEW_CHARS) : undefined;
        const entry: LatchEntry = {
          toolCallId: item.toolCallId,
          occurredAt: item.occurredAt,
          bytes: item.bytes,
          ...(preview === undefined ? {} : { preview }),
          path: spillPath,
          placeholder: clearedToolResultPlaceholder(spillPath, item.bytes, preview),
        };
        try {
          await writeSpill(spillPath, text);
          latched.set(key, entry);
          persistLatch(entry);
          // The one line that lets a cacheWatch "REWRITTEN IN PLACE at <index>" warning be attributed:
          // without it, clearing a result and stripping an image are the same silence in the log, and the
          // two have completely different fixes.
          log.info(`cleared ${item.toolCallId} at message ${item.index} (${trigger} trigger, ${item.bytes} bytes)`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            // SOMETHING already sits at the path: a pre-respawn spill of this same output, or a file
            // the session itself wrote (its own spill dir is inside its allowed paths). Latch only
            // when the on-disk bytes are exactly what we would have written — otherwise the
            // placeholder would point at text that was never the tool's output.
            let onDisk: string | null = null;
            try { onDisk = await readSpill(spillPath); }
            catch { onDisk = null; } // a throwing readSpill must not take the whole turn down
            if (onDisk === text) {
              latched.set(key, entry);
              persistLatch(entry);
              log.info(`re-latched ${item.toolCallId} at message ${item.index} from its existing spill (${trigger} trigger, ${item.bytes} bytes)`);
              continue;
            }
            foreignSpills.add(key);
            log.warn(`tool result spill for ${item.toolCallId} conflicts with a different file on disk — leaving the result in context`);
            continue;
          }
          failedSpills.add(key);
          log.warn(`tool result spill failed for ${item.toolCallId}`, error);
        }
      }
    };
    if (gateOpen) {
      await spillSelected(selectClearableToolResults(base, new Set(latched.keys())), false, 'time');
    }
    // Runs on every pass, gate or no gate: an oversized result of the current run has not reached the
    // provider yet, so this is the only chance to keep it out of the context entirely.
    await spillSelected(selectOversizedToolResults(base, new Set(latched.keys())), true, 'size');
    // Then the aggregate layer, on what the per-result one left behind: many medium results in one
    // wire-level message are individually under the per-result threshold but together are not.
    const budgeted = selectBudgetedToolResults(base, new Set(latched.keys()), budgetDecided);
    await spillSelected(budgeted.spill, true, 'group');
    for (const key of budgeted.decided) budgetDecided.add(key);
    if (latched.size === 0) return base;
    // Resolve each latched occurrence to the message that carries it. Occurrence keys make this exact in
    // the common case; two occurrences can still share a key (same id AND same timestamp, or both
    // timestamp-less), and then the one whose text size equals the latched original is the one that was
    // spilled — when none matches (a respawn can drift the text — see restoreLatch) the EARLIEST wins,
    // because it has been going out as a placeholder the longest and keeping it stable protects the
    // longest cached prefix.
    const occupied = new Set<string>();
    const chosen = new Map<string, { index: number; sized: boolean; entry: LatchEntry }>();
    for (let index = 0; index < base.length; index += 1) {
      const message = base[index];
      if (message?.role !== 'toolResult') continue;
      const occurrence = message as ToolResultMessage;
      const key = occurrenceKeyOf(occurrence);
      occupied.add(key);
      const entry = latched.get(key);
      if (entry === undefined) continue;
      const sized = textBytes(occurrence) === entry.bytes;
      const existing = chosen.get(key);
      if (existing !== undefined) {
        if (!duplicateWarned.has(key)) {
          duplicateWarned.add(key);
          log.warn(`toolCallId ${occurrence.toolCallId} occurs more than once in the history with the same occurrence key — clearing only the occurrence that was spilled`);
        }
        if (existing.sized || !sized) continue;
      }
      chosen.set(key, { index, sized, entry });
    }
    // Prune entries whose occurrence is GONE — a compaction removed the message, so nothing references
    // the placeholder any more and the entry's only remaining power is the harmful one: capturing a
    // future reuse of the id. In memory AND in the durable store, so a respawn cannot resurrect it.
    // Only after a completed restore: a failed restore must cost a re-cache, never rows.
    if (restored) {
      for (const [key, entry] of latched) {
        if (occupied.has(key)) continue;
        latched.delete(key);
        removeLatch(entry.toolCallId, entry.occurredAt);
        log.info(`pruned the latch for ${entry.toolCallId} — its occurrence left the history (compaction)`);
      }
      if (latched.size === 0) return base;
    }
    const cleared = new Map<number, string>();
    for (const pick of chosen.values()) cleared.set(pick.index, pick.entry.placeholder);
    return applyToolResultClearing(base, cleared);
  };
}
