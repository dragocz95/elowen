import { createHash } from 'node:crypto';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { hashCanonical } from './cacheWatch.js';
import { FORK_BOILERPLATE_TAG, FORK_PLACEHOLDER_RESULT } from './forkPrefix.js';

/** A SECOND, trailing prompt-cache breakpoint, so a wide fan-out cannot cost the whole conversation.
 *
 *  Anthropic's prefix checking tests at most 20 positions per breakpoint, counting the breakpoint itself
 *  as the first; when nothing matches it stops, or resumes from the next explicit breakpoint
 *  (docs.anthropic.com, "How automatic prefix checking works"). pi-ai marks exactly one place in the
 *  conversation — the last block of the payload's last user message (`anthropic-messages.js:961-981`) —
 *  and that mark MOVES every request. A step that appends more than 20 blocks (a wide fan-out's
 *  tool_results, a batch of queued steering messages) therefore pushes the previous request's write out
 *  of the new mark's window, the read falls back to the system and tools entries, and the entire history
 *  is written into the cache again. Measured here: reads collapsing from 347k tokens to exactly the
 *  system+tools size, 267k-token rewrites, in turns that had just fanned out.
 *
 *  The documented remedy is a second breakpoint at a position a prior request actually WROTE — the
 *  lookback finds prior writes, not stable content, so a guessed position is worthless. The only such
 *  position below the moving mark is wherever that mark sat on the PREVIOUS request of this session,
 *  which this extension remembers and re-marks: an exact hit at the first position of that breakpoint's
 *  window, whatever the step appended in between. The first deployment of this idea guessed "the user
 *  message before the marked one" instead of remembering, which is only right when a step appends a
 *  single user message — steering mode "all" and background delegation deliveries routinely append
 *  several.
 *
 *  Two refinements keep "a position a prior request actually wrote" TRUE rather than approximate:
 *
 *  1. The remembered position is only trusted once its request SUCCEEDED. `before_provider_request`
 *     fires for requests that then die on a 429/529/400 or are cancelled before the provider processed
 *     the input — no cache entry exists for those, and marking their position would pin a spot nothing
 *     wrote while the lookback only ever finds real writes. So each request stores a CANDIDATE, and
 *     only `after_provider_response` with a 2xx status promotes it (cache entries are written when the
 *     INPUT is processed, so a stream that dies later does not un-write them).
 *
 *  2. The remembered position is identified by the hash of the ENTIRE canonical prefix up to and
 *     including it — system, tools and every message — not by the marked message's own content.
 *     Anthropic keys cache entries by cumulative prefix: after a mid-history insertion (live recall)
 *     the remembered message still exists one position later, but every entry at or past the insertion
 *     is unreachable no matter what is marked, so re-finding the message by content and marking its
 *     shifted position (what the first version did) could only ever spend the slot on a position whose
 *     entry can no longer match. With the prefix hash the module abstains instead — and in the
 *     append-only common case the check degenerates to one comparison at the remembered index.
 *
 *  Anthropic allows four breakpoints per request and rejects a fifth outright. With an OAuth token
 *  pi-ai already spends all four (Claude Code identity block, system prompt, last tool, last user —
 *  `anthropic-messages.js:718-731,1012,969`), which made the first deployment a silent no-op in
 *  production. The identity-block entry is strictly redundant — it sits one tiny block after the
 *  all-tools entry — so this module keeps only the LAST marked system block and uses the freed slot.
 *  Markers are caching metadata outside the prefix hash (the docs' growing-conversation example depends
 *  on that: turn 2 hits an entry at a position its own payload no longer marks), so stripping one never
 *  invalidates entries earlier requests wrote. */

const BREAKPOINT_MAX = 4;

type Block = Record<string, unknown>;

/** Only these block types may carry a marker — mirroring the type test pi-ai itself applies before
 *  marking, so this can never produce a payload shape the provider would refuse. */
const MARKABLE = new Set(['text', 'image', 'tool_result']);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function blocksOf(message: unknown): Block[] | undefined {
  const content = record(message)?.content;
  if (!Array.isArray(content)) return undefined;
  const blocks = content.filter((block): block is Block => record(block) !== undefined);
  return blocks.length === content.length ? blocks : undefined;
}

/** Keep only the LAST marked system block. An OAuth payload marks both the Claude Code identity block and
 *  the system prompt; together with the tools and last-user markers that exhausts the four-slot budget
 *  and starves the trailing breakpoint of the slot it needs. The dropped entry covered the same prefix as
 *  the all-tools entry plus one ~15-token block, and a system-prompt change still recovers the tools
 *  prefix through the lookback, two positions back. Run unconditionally so write positions stay identical
 *  from request to request instead of flickering with the marker count. */
function stripDuplicateSystemMarkers(payload: Record<string, unknown>): void {
  const system = Array.isArray(payload.system) ? payload.system : undefined;
  if (!system) return;
  const marked = system
    .map(record)
    .filter((block): block is Record<string, unknown> => block?.cache_control !== undefined);
  for (const block of marked.slice(0, -1)) delete block.cache_control;
}

/** Count every marker in the payload — the WHOLE payload, root included. The budget is per REQUEST: a
 *  top-level `cache_control` (the automatic breakpoint form) consumes one of the four slots exactly
 *  like a block-level marker, so a walk that only visited system/tools/messages would under-count and
 *  let this module add a fifth — an HTTP 400 on every such request. Walking the full object also keeps
 *  any future carrier position counted without another edit here. */
function countBreakpoints(payload: Record<string, unknown>): number {
  let total = 0;
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    const object = record(value);
    if (!object) return;
    if (object.cache_control !== undefined) total += 1;
    for (const item of Object.values(object)) walk(item);
  };
  walk(payload);
  return total;
}

/** The message pi-ai marked on THIS request, and the marker value it used. The value is reused verbatim
 *  rather than reconstructed: it encodes the TTL derived from `PI_CACHE_RETENTION`, and a literal written
 *  here would silently disagree with the rest of the payload the first time that setting changed. Absent
 *  marker means pi-ai did not cache this request at all — in which case adding one of our own would be
 *  inventing a policy it deliberately did not apply. */
function currentMarker(messages: readonly unknown[]): { value: unknown; messageIndex: number } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const blocks = blocksOf(messages[index]);
    if (!blocks) continue;
    for (let block = blocks.length - 1; block >= 0; block -= 1) {
      const value = blocks[block]?.cache_control;
      if (value !== undefined) return { value, messageIndex: index };
    }
  }
  return undefined;
}

/** The text of a block, whether the provider shape carries it directly or nests it one level (a
 *  `tool_result` holds an array of blocks). Only used to recognise the fork boundary below. */
function blockText(block: Block): string {
  if (typeof block.text === 'string') return block.text;
  const nested = block.content;
  if (typeof nested === 'string') return nested;
  if (!Array.isArray(nested)) return '';
  return nested.map((item) => (typeof record(item)?.text === 'string' ? record(item)!.text as string : '')).join('');
}

/** Whether this is the message that carries a fork child's directive. The boilerplate tag is matched
 *  anywhere in the text rather than at its start, because the child's own per-turn context frame is
 *  prepended into the same block before the payload leaves. */
function isForkDirective(message: unknown): boolean {
  const blocks = blocksOf(message);
  if (!blocks || record(message)?.role !== 'user') return false;
  return blocks.some((block) => block.type === 'text' && blockText(block).includes(`<${FORK_BOILERPLATE_TAG}>`));
}

/** Whether this message is one of the stand-in results a fork answers the parent's open tool calls with.
 *  Every block has to be one: a message that mixes them with anything else is not the fork's own. */
function isForkPlaceholder(message: unknown): boolean {
  const blocks = blocksOf(message);
  if (!blocks || blocks.length === 0 || record(message)?.role !== 'user') return false;
  return blocks.every((block) => block.type === 'tool_result' && blockText(block) === FORK_PLACEHOLDER_RESULT);
}

/** The last message a FORK child inherited from its parent, or undefined when this payload is not a
 *  fork's opening request.
 *
 *  A fork child exists to read a prefix its PARENT wrote, and the parent's own last request marked its
 *  last user message. The child appends the placeholder results and its directive behind that message, so
 *  pi-ai's single moving mark lands on the directive instead and the position the parent actually wrote is
 *  left unmarked — with no previous request of its own, this module has nothing remembered to re-mark
 *  either. Stepping back over the fork's own additions lands exactly on the parent's marked position, and
 *  it is the ONE case where the position can be named without having observed the request that wrote it:
 *  the boundary is this module's own construction, not a guess about what the payload happens to contain.
 *
 *  Deliberately narrow: it recognises the boundary by the fork's own constant blocks, so an ordinary
 *  session's first request finds nothing here and is left untouched. */
function forkInheritedTail(messages: readonly unknown[], markedIndex: number): number | undefined {
  if (!isForkDirective(messages[markedIndex])) return undefined;
  for (let index = markedIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (record(message)?.role !== 'user' || isForkPlaceholder(message) || isForkDirective(message)) continue;
    // The parent's trailing assistant message and pi-ai's own system entries sit between the boundary and
    // the parent's last user message; only the latter can carry a marker, and only it is where the
    // parent's own mark sat.
    const blocks = blocksOf(message);
    const last = blocks?.[blocks.length - 1];
    return last && typeof last.type === 'string' && MARKABLE.has(last.type) ? index : undefined;
  }
  return undefined;
}

/** Where the previous SUCCESSFUL request's marked message sat, identified by the hash of the whole
 *  canonical prefix ending there (system + tools + messages 0..index). Cumulative on purpose — see the
 *  module comment's refinement 2: Anthropic keys cache entries by cumulative prefix, so a message-local
 *  hash can match while the entry is unreachable. */
interface PreviousWrite { index: number; prefixHash: string }

/** Fold one more segment into a running prefix digest. Chained sha256 over the segments' canonical
 *  hashes: deterministic, order-sensitive, and each request costs one linear pass (the same order of
 *  work cacheWatch already spends hashing its payload snapshot). */
function chainHash(prefix: string, segment: string): string {
  return createHash('sha256').update(prefix).update(segment).digest('hex');
}

/** Put the marker pi-ai used on the last message a fork child inherited from its parent. No-op when the
 *  payload is not a fork's opening request, when the four-slot budget is already spent, or when the
 *  position already carries one. Shares both guards with the remembered-position path below, so neither
 *  can produce a fifth breakpoint the provider would reject. */
function markInherited(
  object: Record<string, unknown>,
  messages: readonly unknown[],
  marker: { value: unknown; messageIndex: number },
): void {
  const inherited = forkInheritedTail(messages, marker.messageIndex);
  if (inherited === undefined) return;
  if (countBreakpoints(object) >= BREAKPOINT_MAX) return;
  const blocks = blocksOf(messages[inherited]);
  const last = blocks?.[blocks.length - 1];
  if (!last || last.cache_control !== undefined) return;
  last.cache_control = marker.value;
}

export interface TrailingCacheBreakpoint {
  /** `before_provider_request`: possibly mark the previous confirmed write position, and stage this
   *  request's own mark as the next candidate. Returns the payload to send (mutated in place). */
  request(payload: unknown): unknown;
  /** `after_provider_response`: a 2xx promotes the staged candidate to the confirmed write position;
   *  anything else discards it (the previous confirmed write, if any, remains valid — a failed request
   *  does not un-write an existing cache entry). */
  response(status: number): void;
}

/** One per session — the memory of where the previous request's mark sat IS the mechanism, so a shared
 *  instance would cross-wire sessions. Exported for tests. */
export function createTrailingCacheBreakpoint(): TrailingCacheBreakpoint {
  /** The last position a SUCCEEDED request marked — the only kind the lookback can find. */
  let confirmed: PreviousWrite | undefined;
  /** The position the in-flight request marked, awaiting its outcome. */
  let candidate: PreviousWrite | undefined;
  /** No request of this session has SUCCEEDED yet, so the fork boundary below is still the opening one.
   *  After that the remembered position is a real observation and always the better answer.
   *
   *  Spent by the response, not by the request: a fork's opening request that comes back 429 or 529 is
   *  retried, and a flag consumed by the failed attempt left that retry without the inherited mark — one
   *  full re-cache of the whole parent prefix, for a transient fault. Mirrors `confirmed` below, which has
   *  always moved only on a 2xx. */
  let first = true;
  return {
    request(payload) {
      candidate = undefined;
      const object = record(payload);
      if (!object) return payload;
      stripDuplicateSystemMarkers(object);
      const messages = Array.isArray(object.messages) ? object.messages : undefined;
      if (!messages || messages.length === 0) return payload;
      const marker = currentMarker(messages);
      if (!marker) {
        // A remembered position from before a no-cache request describes a write this module can no
        // longer reason about; carrying it across the gap would pin a position on trust alone.
        confirmed = undefined;
        return payload;
      }
      // One forward pass builds the candidate's prefix hash AND checks the confirmed position's prefix
      // is still byte-identical in this payload. Any insertion, removal or rewrite at or before the
      // confirmed index changes the chain and makes `stillThere` false — which is correct, because the
      // cache entry written there is keyed on the old prefix and can no longer be hit.
      const remembered = confirmed;
      let chain = chainHash(hashCanonical(object.system), hashCanonical(object.tools));
      let stillThere = false;
      for (let index = 0; index <= marker.messageIndex; index += 1) {
        chain = chainHash(chain, hashCanonical(messages[index]));
        if (remembered && index === remembered.index && chain === remembered.prefixHash) stillThere = true;
      }
      candidate = { index: marker.messageIndex, prefixHash: chain };
      const opening = first;
      if (!remembered || !stillThere) {
        // A fork's OPENING request has nothing remembered — and is the one request that most needs the
        // second breakpoint, because the position its parent wrote is now several messages behind pi-ai's
        // single moving mark. Mark it explicitly; every later request of this child has its own
        // observation to use and takes the path above.
        if (opening && !remembered) markInherited(object, messages, marker);
        return payload;
      }
      // A retry (nothing appended) re-marks the same position pi-ai already marks; nothing to add.
      if (remembered.index >= marker.messageIndex) return payload;
      if (countBreakpoints(object) >= BREAKPOINT_MAX) return payload;
      const blocks = blocksOf(messages[remembered.index]);
      const last = blocks?.[blocks.length - 1];
      if (!last || typeof last.type !== 'string' || !MARKABLE.has(last.type)) return payload;
      if (last.cache_control !== undefined) return payload;
      last.cache_control = marker.value;
      return payload;
    },
    response(status) {
      if (status >= 200 && status < 300) {
        // A request the provider accepted is the one that stops this session being new — including a
        // request that carried no marker at all, which stages no candidate but has still been sent.
        first = false;
        if (candidate) confirmed = candidate;
      }
      candidate = undefined;
    },
  };
}

export function installCacheBreakpoints(pi: ExtensionAPI): void {
  const trailing = createTrailingCacheBreakpoint();
  pi.on('before_provider_request', (event) => trailing.request(event.payload));
  pi.on('after_provider_response', (event) => { trailing.response(event.status); });
}
