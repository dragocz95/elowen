import { logger } from '../../shared/logger.js';
import { sessionToolResultSpillDir } from '../../shared/paths.js';
import type { BrainStore, ClearedToolResultRow } from '../../store/brainStore.js';
import { sessionHasWorkInFlight, type SessionQuiescenceDeps } from '../service/sessionQuiescence.js';
import { OPENAI_CACHE_MAX_RETENTION_MS } from './cacheTiming.js';
import { cacheDefinitelyCold } from './coldStartCompaction.js';
import { collapseHistoricalImages, type PiAgentMessage } from './historyImageStripping.js';
import { imagesRejected } from './imageRejection.js';
import {
  TURN_START_KEEP_USER_TURNS,
  clearedToolResultContent,
  clearedToolResultDetails,
  clearedToolResultPlaceholder,
  defaultReadSpill,
  defaultWriteSpill,
  selectClearableToolResults,
  toolResultSpillPath,
  toolResultText,
} from './toolResultClearing.js';

const log = logger('brain-tool-clearing');

/** Time-triggered tool-result clearing, run at the START of a turn whose prompt cache has provably
 *  expired — beside {@link maybeColdStartCompaction}, under the lock that turn already holds, before the
 *  user's new message is admitted.
 *
 *  This is what makes the stored transcript the wire truth for OLD results. The other trigger decides at
 *  delivery, where nothing has been sent yet and no rewrite exists; here the results HAVE been sent, so
 *  the rewrite is only ever safe when the prefix that carried them is provably gone. That is the whole
 *  content of the gate, and it needs both halves:
 *
 *  · {@link cacheDefinitelyCold} — no stored row and no explicit interaction inside the last request's
 *    TTL plus a minute. Within one session that is equivalent to "no provider request inside the TTL",
 *    because every request happens inside a prompt which writes its rows within seconds.
 *  · {@link sessionHasWorkInFlight} — the equivalence above holds only WITHIN one session. A running fork
 *    child re-sends its parent's prefix on every one of its own requests and keeps that server-side cache
 *    warm while the parent's rows quietly age past the TTL. The same predicate also covers a queued
 *    message, a parked question and an armed goal, each of which means the context is not this turn's to
 *    rewrite.
 *
 *  Order of effects: spill file, then ALL rows in one transaction, then the live messages in place,
 *  synchronously with no await between the commit and the mutation. The row goes first because the row is
 *  the truth: a crash after the commit and before the mutation loses the in-memory copy anyway and a
 *  respawn reads the placeholder, whereas memory-first would let a crash between a request that already
 *  carried the placeholder and the row write send the full text again — rewriting a warm prefix with
 *  content the model has already stopped seeing.
 *
 *  The mutation is deliberately IN PLACE. PI shares one tool-result message object between the loop
 *  context, `agent.state.messages`, the SessionManager entry and the `agent_end` event, and mutates
 *  messages in place itself for exactly that reason, so writing through the object keeps every reader in
 *  agreement — including the end-of-run re-persist, which rebuilds the rows from those same objects. */

/** What the pass needs beyond the live session: the two registries the quiescence predicate consults plus
 *  the two store reads/writes. Structural, so the owner turn runner and the channel service both satisfy
 *  it with the dependencies they already hold. */
export interface ColdToolResultClearingDeps extends SessionQuiescenceDeps {
  store: SessionQuiescenceDeps['store']
    & Pick<BrainStore, 'lastMessageAt' | 'lastForkChildMessageAt' | 'clearToolResultRows'>;
}

/** The live-session facts the pass reads — the same structural shape as {@link ColdCompactionSession}, so
 *  both triggers take the same argument at the same call site. */
export interface ColdToolResultSession {
  session: { messages: PiAgentMessage[]; isStreaming: boolean; isCompacting: boolean };
  sessionId: string;
  interactedAt?: number;
  lastRequestCacheTtlMs?: number;
  /** The longest this session's PROVIDER may hold an inactive prompt cache, whatever TTL the request
   *  declared (see {@link providerCacheRetentionFloorMs}). Unset on providers that honour the declared
   *  retention, where the stamped TTL is already the whole answer. */
  cacheRetentionFloorMs?: number;
}

export interface ColdToolResultClearingOptions {
  /** Directory the spill files land in; defaults to the session's resolved spill dir. */
  spillDir?: string;
  /** Clock injection for tests. */
  now?: () => number;
  writeSpill?: (path: string, text: string) => Promise<void>;
  readSpill?: (path: string) => Promise<string | null>;
}

/** Never throws and never blocks the turn: a history that cannot be shrunk simply goes out whole. */
export async function clearColdToolResults(
  d: ColdToolResultClearingDeps,
  live: ColdToolResultSession,
  options: ColdToolResultClearingOptions = {},
): Promise<void> {
  try {
    await clearCold(d, live, options);
  } catch (error) {
    log.warn(`cold turn-start clearing failed on ${live.sessionId} — the history goes out whole`, error);
  }
}

async function clearCold(
  d: ColdToolResultClearingDeps,
  live: ColdToolResultSession,
  options: ColdToolResultClearingOptions,
): Promise<void> {
  if (live.session.isStreaming || live.session.isCompacting) return;
  const now = options.now ?? Date.now;
  const lastMessageAt = d.store.lastMessageAt(live.sessionId);
  // A fork child's requests are this session's prefix being re-sent, so they count as this session's
  // activity — for the whole retention window, not only while the child is still running.
  const forkChildAt = d.store.lastForkChildMessageAt(live.sessionId);
  // Text uses the TTL the requests were actually made under, raised to whatever this PROVIDER may keep an
  // inactive prompt cache for regardless of the retention it was asked for. Without that floor an OpenAI
  // Responses conversation running on the short 5-minute retention had its history rewritten after six
  // minutes, while the provider may still be holding the prefix for the best part of an hour.
  const retentionMs = Math.max(live.lastRequestCacheTtlMs ?? 0, live.cacheRetentionFloorMs ?? 0);
  const cold = cacheDefinitelyCold(lastMessageAt, live.interactedAt, retentionMs || undefined, now(), forkChildAt);
  // Images use the UPPER bound of every provider's retention, whatever this one declares: OpenAI may keep
  // an inactive prompt cache for a full hour, and this pass is the destructive one. A refused image is the
  // exception that overrides the gate entirely — it fails every later request until it is gone, so leaving
  // it in would brick the conversation for that hour.
  const rejected = imagesRejected(live.sessionId);
  const imagesCold = rejected || cacheDefinitelyCold(
    lastMessageAt, live.interactedAt,
    Math.max(retentionMs, OPENAI_CACHE_MAX_RETENTION_MS), now(), forkChildAt,
  );
  if (!cold && !imagesCold) return;
  if (sessionHasWorkInFlight(d, live.sessionId)) return;

  const messages = live.session.messages;
  if (imagesCold) {
    const collapsed = collapseHistoricalImages(messages);
    if (collapsed > 0) {
      log.info(`collapsed images in ${collapsed} message(s) on ${live.sessionId}`
        + ` (${rejected ? 'the provider refused an image' : 'cold turn start'})`);
    }
  }
  if (!cold) return;
  const selected = selectClearableToolResults(messages, TURN_START_KEEP_USER_TURNS);
  if (selected.length === 0) return;

  const spillDir = options.spillDir ?? sessionToolResultSpillDir(process.env, live.sessionId);
  const writeSpill = options.writeSpill ?? defaultWriteSpill;
  const readSpill = options.readSpill ?? defaultReadSpill;

  const rows: ClearedToolResultRow[] = [];
  /** Resolved to the message OBJECT, not to its index: the mutation below writes through the object PI
   *  shares with its own state, and an index would have to assume the array never moved. */
  const mutations: { message: PiAgentMessage; placeholder: string; details: unknown; toolCallId: string; bytes: number }[] = [];
  for (const item of selected) {
    const message = messages[item.index];
    if (message?.role !== 'toolResult') continue;
    const text = toolResultText(message);
    const path = toolResultSpillPath(spillDir, item.toolCallId, { mode: 'time', bytes: item.bytes });
    if (!await storeSpill(writeSpill, readSpill, path, text, item.toolCallId)) continue;
    const placeholder = clearedToolResultPlaceholder(path, item.bytes);
    const details = clearedToolResultDetails(
      (message as { details?: unknown }).details,
      { mode: 'time', bytes: item.bytes, path },
    );
    rows.push({ toolCallId: item.toolCallId, occurredAt: item.occurredAt, placeholder, details });
    mutations.push({ message, placeholder, details, toolCallId: item.toolCallId, bytes: item.bytes });
  }
  if (rows.length === 0) return;

  const rewritten = d.store.clearToolResultRows(live.sessionId, rows);
  // Synchronously after the commit, with nothing awaited in between: the rows and the live context must
  // never be observable in disagreement by a request that starts in the gap.
  for (const mutation of mutations) {
    const message = mutation.message as { content: unknown; details?: unknown };
    // Text out, everything else in place: an image block has nothing in the spill file and would simply
    // be destroyed. The images pass above has already collapsed the historical ones when the image gate
    // was open, so what survives here is what that gate deliberately kept.
    message.content = clearedToolResultContent(
      Array.isArray(message.content) ? message.content as { type: string }[] : [],
      mutation.placeholder,
    );
    message.details = mutation.details;
    // The one line that lets a cacheWatch "history rewritten in place" warning be attributed: clearing a
    // result and stripping an image are otherwise the same silence in the log, with different fixes.
    log.info(`cleared ${mutation.toolCallId} (cold turn start, ${mutation.bytes} bytes)`);
  }
  log.info(`cleared ${mutations.length} tool result(s) on ${live.sessionId} at a cold turn start (${rewritten} row(s) rewritten)`);
}

/** Write the spill write-once, adopting a byte-identical file already at the path (a previous pass whose
 *  row write never landed leaves exactly that). A genuine conflict, or any other failure, leaves the
 *  result in context: there is no retry set, because the next cold start simply tries again and the
 *  adoption then makes it free. */
async function storeSpill(
  writeSpill: (path: string, text: string) => Promise<void>,
  readSpill: (path: string) => Promise<string | null>,
  path: string,
  text: string,
  toolCallId: string,
): Promise<boolean> {
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
