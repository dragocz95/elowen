import { createHash } from 'node:crypto';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { logger } from '../../shared/logger.js';
import { cacheTtlMs, OPENAI_CACHE_TTL_MS } from './cacheTiming.js';
import { currentTurnMode, type TurnWorkMode } from '../../plugins/policyContext.js';

/** Prompt-cache observability, modeled on Claude Code's promptCacheBreakDetection. In a healthy
 * append-only conversation `cacheRead` grows monotonically: each request reads the prefix the previous
 * request wrote. A DROP means the prefix changed or the provider evicted/routed away from it. The payload
 * monitor hashes the exact provider request so the warning can distinguish those cases without retaining
 * prompt content.
 *
 * Two expected drops are suppressed: a real compaction (baseline resets) and an idle gap beyond the cache
 * TTL. Installed for Anthropic sessions ('anthropic' flavor: usage.cacheRead/cacheWrite from
 * cache_read/creation_input_tokens) and for ChatGPT-backend sessions ('openai-responses' flavor: pi-ai
 * maps input_tokens_details.cached_tokens → usage.cacheRead and cache_write_tokens → usage.cacheWrite in
 * openai-responses-shared.js; the chatgpt backend reports no cache writes, so cacheWrite stays 0 and the
 * report omits it rather than claiming "wrote 0"). Other providers report best-effort cache stats whose
 * drops are routine noise. */

const log = logger('brain-cache');

/** Below BOTH thresholds a drop is noise: small absolute swings happen with thinking-block variance. */
export const CACHE_DROP_MIN_TOKENS = 2000;
const CACHE_DROP_MIN_RATIO = 0.05;
/** The provider request can contain thousands of messages. Tracking its stable prefix is enough to catch
 * egress rewrites while bounding both hashing work and retained digests. */
/** Anthropic's documented lookback: prefix checking tests at most 20 positions per breakpoint, counting
 * the breakpoint itself as the first, then stops or resumes from the next explicit breakpoint
 * (docs.anthropic.com, "How automatic prefix checking works"). A step that appends more blocks than this
 * pushes every earlier write out of the final breakpoint's window — the fan-out failure mode
 * `cacheBreakpoints` exists to prevent. Used here only to name the likely cause, never to decide. */
const BLOCK_LOOKBACK = 20;
const MAX_TRACKED_HISTORY_SEGMENTS = 512;
const MAX_TRACKED_TOOL_SEGMENTS = 256;
const MAX_PENDING_SNAPSHOTS = 2;

interface HashedSegment {
  hash: string;
  label: string;
  /** Tool segments only: the schema carries Anthropic's `defer_loading`, so the API keeps it OUT of the
   *  cached prefix (see {@link deferredOnlyAppend}). */
  deferred?: true;
}

interface CachePayloadSnapshot {
  systemHash: string;
  toolsHash: string;
  tools: HashedSegment[];
  toolCount: number;
  deferredToolCount: number;
  history: HashedSegment[];
  historyCount: number;
  /** Content blocks across all messages — see {@link countBlocks}. */
  blockCount: number;
  /** Work mode of the turn that sent this request, captured while the prompt scope is still active. */
  turnMode?: TurnWorkMode;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? '').digest('hex');
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Strip every `cache_control` marker before hashing. The marker is CACHING POLICY, not conversation
 *  content, and pi-ai moves it onto the payload's last user message on every request — so the message that
 *  carried it last time no longer does, its hash differs, and the comparison reports the previous tail as
 *  "rewritten in place" on every single step of a tool loop. That false positive is not cosmetic: it named
 *  an innocent module as the culprit for a real cost defect and sent an investigation the wrong way for
 *  hours. Hashing the canonical content makes "rewritten" mean what it says. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const object = record(value);
  if (!object) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(object)) {
    if (key === 'cache_control') continue;
    // A message whose `content` is a bare string is wire-equivalent to a single text block: when pi-ai moves
    // the cache marker onto the payload's last user message it rewrites `content: "x"` into
    // `[{type:'text', text:'x', cache_control}]` (anthropic-messages.js). The SAME message therefore hashes
    // differently on the step it stops being last — reported as "rewritten in place" though nothing changed.
    // Fold both shapes to the block form (cache_control already stripped above) so a rewrite means the text
    // moved, not the wire shape. Scoped to objects carrying a `role`, i.e. messages, not arbitrary nesting.
    if (key === 'content' && typeof item === 'string' && typeof object.role === 'string') {
      out[key] = [{ type: 'text', text: item }];
      continue;
    }
    out[key] = canonical(item);
  }
  return out;
}

/** One message, hashed over its canonical content. Shared with cacheBreakpoints, which must recognize
 *  "the same message as last request" by content — through the marker pi-ai moves every step — with the
 *  exact equality this monitor's comparisons are built on, or the two modules would disagree about
 *  whether history changed. */
export function hashCanonical(value: unknown): string {
  return hash(canonical(value));
}

/** The same canonicalization {@link hashCanonical} digests, exposed as the structure itself. A prefix
 *  assertion that compares digests can only say THAT two payloads diverged; comparing the canonical
 *  values names the message and shows the content that moved. Kept beside the hash rather than
 *  reimplemented in a test so the two can never disagree about what "the same message" means. */
export function canonicalPayload(value: unknown): unknown {
  return canonical(value);
}

/** Total content blocks across the payload's messages. Anthropic resolves a cache hit by scanning back a
 *  limited window of blocks from a breakpoint, so the number of blocks a single step ADDED is what decides
 *  whether the previous cached segment is still reachable — the one figure that separates a fan-out miss
 *  from every other cause, and the reason it is recorded here rather than inferred later. */
function countBlocks(messages: readonly unknown[]): number {
  let total = 0;
  for (const message of messages) {
    const content = record(message)?.content;
    total += Array.isArray(content) ? content.length : 1;
  }
  return total;
}

function safeToolLabel(value: unknown, index: number): string {
  const name = record(value)?.name;
  if (typeof name !== 'string') return `#${index}`;
  return name.startsWith('mcp__') ? 'mcp' : name;
}

function historyLabel(value: unknown, index: number): string {
  const message = record(value);
  // Anthropic messages carry `role`; OpenAI Responses input items without one (function_call,
  // function_call_output, reasoning, tool_search_call…) are labeled by their item `type` instead.
  const role = typeof message?.role === 'string' ? message.role
    : typeof message?.type === 'string' ? message.type : 'unknown';
  const content = Array.isArray(message?.content) ? message.content : [];
  const toolResult = content.some((block) => record(block)?.type === 'tool_result');
  return `${index}:${role}${toolResult ? '/tool_result' : ''}`;
}

function isDeferredTool(value: unknown): boolean {
  return record(value)?.defer_loading === true;
}

function snapshotPayload(value: unknown, turnMode: TurnWorkMode | undefined): CachePayloadSnapshot {
  const payload = record(value);
  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  // Anthropic requests carry `system` + `messages`; OpenAI Responses requests carry `instructions` +
  // `input` (items rather than role messages). Read whichever pair is present so one snapshot shape
  // serves both flavors.
  const messages = Array.isArray(payload?.messages) ? payload.messages
    : Array.isArray(payload?.input) ? payload.input : [];
  return {
    systemHash: hash(canonical(payload?.system ?? payload?.instructions)),
    toolsHash: hash(canonical(tools)),
    tools: tools.slice(0, MAX_TRACKED_TOOL_SEGMENTS).map((tool, index) => ({
      hash: hash(canonical(tool)),
      label: safeToolLabel(tool, index),
      ...(isDeferredTool(tool) ? { deferred: true as const } : {}),
    })),
    toolCount: tools.length,
    deferredToolCount: tools.filter(isDeferredTool).length,
    history: messages.slice(0, MAX_TRACKED_HISTORY_SEGMENTS).map((message, index) => ({
      hash: hash(canonical(message)), label: historyLabel(message, index),
    })),
    historyCount: messages.length,
    blockCount: countBlocks(messages),
    ...(turnMode ? { turnMode } : {}),
  };
}

/** One recorder per session. The pre-request extension stores only bounded hashes; cacheWatch consumes the
 * corresponding snapshot when that request's assistant message ends. */
export interface CachePayloadMonitor {
  extension: (pi: ExtensionAPI) => void;
  consumeSnapshot: () => CachePayloadSnapshot | undefined;
  /** Drop snapshots that predate a compaction, so none can pair with a post-compaction response. */
  clearPending: () => void;
}

export function createCachePayloadMonitor(): CachePayloadMonitor {
  const pending: CachePayloadSnapshot[] = [];
  return {
    extension: (pi) => {
      pi.on('before_provider_request', (event) => {
        // currentTurnMode() is only meaningful here, inside the prompt scope that owns the request; the
        // message_end handler that consumes the snapshot has no such guarantee.
        pending.push(snapshotPayload(event.payload, currentTurnMode()));
        while (pending.length > MAX_PENDING_SNAPSHOTS) pending.shift();
      });
    },
    consumeSnapshot: () => pending.shift(),
    clearPending: () => { pending.length = 0; },
  };
}

function changedLabels(previous: HashedSegment[], current: HashedSegment[]): string[] {
  const changed: string[] = [];
  const common = Math.min(previous.length, current.length);
  for (let index = 0; index < common; index += 1) {
    if (previous[index]?.hash !== current[index]?.hash) {
      changed.push(current[index]?.label ?? `#${index}`);
    }
  }
  return changed;
}

function formatLabels(labels: string[]): string {
  const visible = labels.slice(0, 5);
  return `${visible.join(', ')}${labels.length > visible.length ? ` (+${labels.length - visible.length} more)` : ''}`;
}

/** A position-aligned comparison cannot tell a REWRITE from a SHIFT: insert one message mid-history and
 *  every later index mismatches, which reads as though the whole tail was rewritten. The distinction is
 *  the whole point of this warning — a rewrite of an already-sent message is a cost defect we must fix,
 *  while an insertion is ordinary (live recall anchors a frozen meta message into the stream). So the
 *  divergence is classified instead of merely listed. */
type SegmentDelta =
  | { kind: 'none' }
  | { kind: 'appended'; count: number }
  | { kind: 'dropped'; count: number }
  | { kind: 'rewritten'; label: string; labels: string[] }
  | { kind: 'inserted'; label: string; count: number }
  | { kind: 'removed'; label: string; count: number };

/** How far ahead to look for the originals resuming. Past a handful of segments the shift hypothesis
 *  stops being more likely than a genuine rewrite, and saying "rewritten" is the safer report. */
const MAX_SHIFT_PROBE = 16;

/** Do `original`'s segments resume `shift` positions later in `shifted` — i.e. was something inserted at
 *  `at`? Two consecutive matches are required so a single coincidental hash cannot pass as a shift. */
function resumesAfterShift(
  original: HashedSegment[],
  shifted: HashedSegment[],
  at: number,
  shift: number,
): boolean {
  const probe = Math.min(2, original.length - at);
  if (probe <= 0) return false;
  for (let offset = 0; offset < probe; offset += 1) {
    if (original[at + offset]?.hash !== shifted[at + shift + offset]?.hash) return false;
  }
  return true;
}

/** Anthropic's cache is prefix-based, so only the FIRST divergence can explain a drop; everything after
 *  it is already past the break. */
function classifySegments(previous: HashedSegment[], current: HashedSegment[]): SegmentDelta {
  const common = Math.min(previous.length, current.length);
  let diverged = -1;
  for (let index = 0; index < common; index += 1) {
    if (previous[index]?.hash !== current[index]?.hash) { diverged = index; break; }
  }
  if (diverged < 0) {
    if (current.length > previous.length) return { kind: 'appended', count: current.length - previous.length };
    if (current.length < previous.length) return { kind: 'dropped', count: previous.length - current.length };
    return { kind: 'none' };
  }
  for (let shift = 1; shift <= MAX_SHIFT_PROBE; shift += 1) {
    if (resumesAfterShift(previous, current, diverged, shift)) {
      return { kind: 'inserted', label: current[diverged]?.label ?? `#${diverged}`, count: shift };
    }
    if (resumesAfterShift(current, previous, diverged, shift)) {
      return { kind: 'removed', label: previous[diverged]?.label ?? `#${diverged}`, count: shift };
    }
  }
  return {
    kind: 'rewritten',
    label: current[diverged]?.label ?? `#${diverged}`,
    labels: changedLabels(previous, current),
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** The tools array is hashed into the cached prefix as one block, so ANY delta there — an append
 *  included — invalidates every message behind it. Activating a deferred tool mid-conversation is the
 *  common cause and is worth naming as such rather than as an anonymous change. */
function describeToolDelta(delta: SegmentDelta): string {
  switch (delta.kind) {
    case 'appended': return `${plural(delta.count, 'tool')} appended`;
    case 'dropped': return `${plural(delta.count, 'tool')} dropped`;
    case 'inserted': return `${plural(delta.count, 'tool')} inserted at ${delta.label}`;
    case 'removed': return `${plural(delta.count, 'tool')} removed at ${delta.label}`;
    case 'rewritten': return `segments ${formatLabels(delta.labels)}`;
    case 'none': return 'outside tracked segments or order';
  }
}

/** History is append-only in a healthy conversation, so an append is silence. Everything else is
 *  reported, and only `rewritten` is the alarming one. */
function describeHistoryDelta(delta: SegmentDelta): string | undefined {
  switch (delta.kind) {
    case 'none':
    case 'appended':
      return undefined;
    case 'dropped':
      return `history lost ${plural(delta.count, 'trailing message')}`;
    case 'inserted':
      return `${plural(delta.count, 'message')} inserted into history at ${delta.label} `
        + '(a shift, not a rewrite — the prefix resumes unchanged after it)';
    case 'removed':
      return `${plural(delta.count, 'message')} removed from history at ${delta.label}`;
    case 'rewritten':
      return `history REWRITTEN IN PLACE at ${delta.label} — an already-sent message changed`;
  }
}

/** Anthropic excludes `defer_loading` tools from the system-prompt prefix and expands them inline through
 *  `tool_reference` blocks, so appending one CANNOT be what broke the prefix — reporting it as the cause
 *  sends the reader after the wrong culprit (activating a deferred tool is exactly when the payload grows
 *  by one deferred schema). Only an append is forgiven: a tool moving out of the deferred tail, or any
 *  edit among the immediate ones, does change the cached block. Truncated tracking abstains, since the
 *  appended segments may lie past the tracked window. */
function deferredOnlyAppend(
  delta: SegmentDelta,
  previous: CachePayloadSnapshot,
  current: CachePayloadSnapshot,
): boolean {
  if (delta.kind !== 'appended') return false;
  if (previous.tools.length !== previous.toolCount || current.tools.length !== current.toolCount) return false;
  const appended = current.tools.slice(previous.tools.length);
  return appended.length > 0 && appended.every((segment) => segment.deferred === true);
}

function attributePayloadChange(
  previous: CachePayloadSnapshot | undefined,
  current: CachePayloadSnapshot | undefined,
  flavor: CacheWatchFlavor,
): string {
  if (!previous || !current) return 'payload snapshot unavailable';
  const changes: string[] = [];
  const notes: string[] = [];
  // Worth reporting as CONTEXT, never as the cause. Plan mode used to narrow the tool set, which rehashed
  // the prefix and made a switch an expected break — but enforcement moved to execute time, so the mode no
  // longer touches system or tools at all. A drop that coincides with a switch is therefore a REAL break,
  // and calling the mode the culprit would suppress the eviction hint below and send the next
  // investigation somewhere there is nothing to find.
  const modeSwitched = previous.turnMode && current.turnMode && previous.turnMode !== current.turnMode;
  if (previous.systemHash !== current.systemHash) changes.push('system prompt changed');
  if (previous.toolsHash !== current.toolsHash) {
    const delta = classifySegments(previous.tools, current.tools);
    const count = previous.toolCount === current.toolCount ? '' : `, count ${previous.toolCount}→${current.toolCount}`;
    if (deferredOnlyAppend(delta, previous, current)) {
      notes.push(`${plural(current.deferredToolCount, 'deferred tool')} in the payload`
        + `${count} — excluded from the cached prefix, so not the cause`);
    } else {
      const deferred = current.deferredToolCount > 0 ? `, ${current.deferredToolCount} deferred` : '';
      changes.push(`tools changed (${describeToolDelta(delta)}${count}${deferred})`);
    }
  }
  const historyDelta = describeHistoryDelta(classifySegments(previous.history, current.history));
  if (historyDelta) changes.push(historyDelta);
  if (current.historyCount < previous.historyCount) {
    changes.push(`history truncated ${previous.historyCount}→${current.historyCount}`);
  }
  if (modeSwitched) notes.push(`turn mode changed ${previous.turnMode}→${current.turnMode}`);
  const suffix = notes.length > 0 ? ` [${notes.join('; ')}]` : '';
  if (changes.length > 0) return `${changes.join('; ')}${suffix}`;
  const tracked = Math.min(previous.history.length, current.history.length);
  const prefix = notes.length > 0 ? 'cached prefix unchanged' : 'tracked payload prefix unchanged';
  const unchanged = `${prefix} (system, tools, first ${tracked} history messages)`;
  // Nothing in the payload changed, so the prefix was still THERE — it just could not be found from the
  // breakpoint. Naming that explicitly is the difference between an actionable warning and "eviction,
  // shrug": one says which code to fix, the other says the provider had a bad day.
  //
  // Anthropic only: the lookback/breakpoint mechanics do not exist on OpenAI's prompt cache (automatic
  // longest-prefix matching, no breakpoints), so attributing an OpenAI drop to a fan-out miss would name
  // a mechanism that is not there.
  const added = current.blockCount - previous.blockCount;
  if (flavor === 'anthropic' && added > BLOCK_LOOKBACK) {
    return `${unchanged}; this step appended ${added} content blocks, past the ${BLOCK_LOOKBACK}-position `
      + `lookback window Anthropic scans from a breakpoint — a FAN-OUT MISS, not a rewrite${suffix}`;
  }
  if (flavor === 'openai-responses') {
    return `${unchanged}; likely provider eviction or routing (OpenAI prompt caching is best-effort)${suffix}`;
  }
  return `${unchanged}; likely provider eviction or routing${suffix}`;
}

interface DropReport {
  sessionId?: string;
  from: number;
  to: number;
  wrote?: number;
  gapMs: number;
  flavor: CacheWatchFlavor;
  previous?: CachePayloadSnapshot;
  current?: CachePayloadSnapshot;
}

/** The whole incident, on its own lines.
 *
 *  A prompt-cache break is diagnosed hours later, from a log file, by someone who cannot reproduce it. So
 *  everything needed to tell the causes apart has to be IN the record: which conversation it happened in,
 *  what was actually read and written (the write IS the cost), how much this one step appended, and the
 *  payload verdict. The previous one-line form carried none of the payload shape — and that omission cost
 *  a whole investigation, because the block delta is the single figure that separates a fan-out miss from
 *  a genuine rewrite, and it simply was not written down. */
function formatDropReport(r: DropReport): string {
  const lines = [
    `prompt cache read dropped within a warm window${r.sessionId ? ` — session ${r.sessionId}` : ''}`,
    `  read     ${r.from} → ${r.to} tokens (lost ${r.from - r.to})`
    + `${typeof r.wrote === 'number' ? `, wrote ${r.wrote}` : ''}`,
    `  gap      ${Math.round(r.gapMs / 1000)}s since the previous response`,
  ];
  if (r.previous && r.current) {
    const added = r.current.blockCount - r.previous.blockCount;
    lines.push(r.flavor === 'openai-responses'
      ? `  payload  ${r.previous.historyCount} → ${r.current.historyCount} input items (`
        + `${r.current.historyCount - r.previous.historyCount >= 0 ? '+' : ''}${r.current.historyCount - r.previous.historyCount} this step)`
      : `  payload  ${r.previous.historyCount} → ${r.current.historyCount} messages, `
        + `${r.previous.blockCount} → ${r.current.blockCount} content blocks (${added >= 0 ? '+' : ''}${added} this step)`);
    const deferred = r.current.deferredToolCount > 0 ? ` (${r.current.deferredToolCount} deferred)` : '';
    lines.push(`  tools    ${r.current.toolCount}${deferred}`);
  }
  lines.push(`  verdict  ${attributePayloadChange(r.previous, r.current, r.flavor)}`);
  return lines.join('\n');
}

type SessionEvent = { type?: string; message?: { role?: string; timestamp?: number; stopReason?: string; usage?: { cacheRead?: number; cacheWrite?: number } }; aborted?: boolean; result?: unknown };
type Subscribable = { subscribe?: (listener: (event: SessionEvent) => void) => unknown };

/** Which provider wire this watch reads. Same detector and thresholds either way; the flavor only picks
 *  the payload shape already handled by snapshotPayload, the warm-window default, and the report wording
 *  (no Anthropic fan-out verdict and no "wrote 0" line for a backend that does not report cache writes). */
export type CacheWatchFlavor = 'anthropic' | 'openai-responses';

export interface CacheWatchOptions {
  /** Warm window in ms; a drop after a longer gap is TTL expiry, not a break. Defaults to the flavor's
   * cache TTL MINUS a 1-minute buffer — the opposite rounding direction from the clearing gate. */
  ttlMs?: number;
  now?: () => number;
  monitor?: CachePayloadMonitor;
  /** Conversation id to report in warnings, so a drop can be traced to the session it happened in. */
  sessionId?: string;
  /** Provider wire being watched; defaults to 'anthropic' (the original sole flavor). */
  flavor?: CacheWatchFlavor;
}

export function installCacheWatch(
  session: Subscribable,
  options: CacheWatchOptions = {},
): void {
  if (typeof session.subscribe !== 'function') return;
  const flavor = options.flavor ?? 'anthropic';
  const defaultTtl = flavor === 'openai-responses' ? OPENAI_CACHE_TTL_MS : cacheTtlMs(process.env);
  const ttlMs = options.ttlMs ?? (defaultTtl - 60_000);
  const now = options.now ?? Date.now;
  let previous: { cacheRead: number; at: number; snapshot?: CachePayloadSnapshot } | null = null;
  session.subscribe((event) => {
    if (event.type === 'compaction_end' && !event.aborted && event.result) {
      // Post-compaction history is genuinely smaller; the next request's lower cacheRead is by design.
      previous = null;
      // A snapshot taken by a request BEFORE the compaction describes a payload that no longer exists;
      // leaving it queued would pair it with the first response after the compaction and attribute the
      // next drop to that stale request.
      options.monitor?.clearPending();
      return;
    }
    if (event.type !== 'message_end') return;
    const message = event.message;
    if (message?.role !== 'assistant') return;
    const snapshot = options.monitor?.consumeSnapshot();
    // A request that errored or was aborted reports usage as all-zero. Consume its request snapshot, but
    // keep the last successful response and payload as the comparison baseline.
    if (message.stopReason === 'error' || message.stopReason === 'aborted') return;
    const cacheRead = message.usage?.cacheRead;
    if (typeof cacheRead !== 'number') return;
    const at = typeof message.timestamp === 'number' ? message.timestamp : now();
    if (previous) {
      const drop = previous.cacheRead - cacheRead;
      if (
        drop > CACHE_DROP_MIN_TOKENS
        && drop / previous.cacheRead > CACHE_DROP_MIN_RATIO
        && at - previous.at < ttlMs
      ) {
        // The chatgpt backend does not report cache_write_tokens (pi-ai maps the absent field to 0);
        // printing "wrote 0" there would read as "the prefix was not re-written" when it simply is not
        // measured. Anthropic's genuine "wrote 0" stays — there it is informative.
        const wrote = message.usage?.cacheWrite;
        const wroteKnown = flavor !== 'openai-responses' || (typeof wrote === 'number' && wrote > 0);
        log.warn(formatDropReport({
          sessionId: options.sessionId,
          from: previous.cacheRead,
          to: cacheRead,
          ...(wroteKnown && typeof wrote === 'number' ? { wrote } : {}),
          gapMs: at - previous.at,
          flavor,
          previous: previous.snapshot,
          current: snapshot,
        }));
      }
    }
    previous = { cacheRead, at, ...(snapshot ? { snapshot } : {}) };
  });
}
