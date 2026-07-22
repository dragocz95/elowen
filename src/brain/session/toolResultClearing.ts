import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { toolResultSpillDir } from '../../shared/paths.js';
import { logger } from '../../shared/logger.js';
import type { PiAgentMessage } from './historyImageStripping.js';

/** Egress-only clearing of large historical tool results — the transferable core of Claude Code's
 *  time-based microcompact, adapted to Elowen's `transformContext` seam (the same hook
 *  `historyImageStripping` composes onto). Anthropic's prompt cache is prefix-based, so the one rule
 *  that matters is: NEVER rewrite history while the cache could still be warm. Two mechanisms enforce
 *  it:
 *
 *  1. The gate opens only when the turn's first user message arrived MORE than the cache TTL after the
 *     previous message — i.e. the cached prefix had already expired and this provider call pays a full
 *     re-cache either way. Clearing here SHRINKS that rewrite instead of costing anything.
 *  2. A per-session latch (Map of cleared toolCallIds → original bytes) guarantees a result once
 *     cleared stays cleared on every later request, so the prefix is byte-stable from then on. The
 *     latch lives in this closure; a respawn loses it. The cache is server-side, so a respawn WITHIN
 *     the TTL is NOT cold — the first request then re-sends the full results and pays one full
 *     re-cache of the restored (larger) prefix. Correct, just expensive; the gate re-clears on the
 *     next idle turn. Rebuilding the latch from disk would also need the original byte counts
 *     persisted (the placeholder embeds them), so we accept the one-off cost instead.
 *
 *  The full text is spilled to `<dataDir>/tool-results/<sessionId>/<toolCallId>.txt` BEFORE the
 *  placeholder replaces it (write-once, `wx`), so clearing loses nothing the model could not re-read
 *  with the Read tool — pathGuard lets every session read its OWN spill dir. Persisted history in
 *  the store is untouched — this runs on PI's egress copy. */

const log = logger('brain-tool-clearing');

/** Results smaller than this stay in context: clearing them saves a handful of tokens while costing a
 *  spill file and a placeholder. 4 KB ≈ 1k tokens. */
export const CLEAR_MIN_BYTES = 4096;

/** How many trailing user turns keep their tool results intact: the current run (after the last user
 *  message) plus the whole previous turn. Everything older is eligible once the gate opens. */
const KEEP_USER_TURNS = 2;

/** pi-ai's short cache TTL is 5 minutes, long (PI_CACHE_RETENTION=long) is 1 hour; the daemon defaults
 *  to long. Resolved from the same env var pi-ai reads, so Elowen and pi-ai never disagree. */
export function cacheTtlMs(env: NodeJS.ProcessEnv): number {
  return env.PI_CACHE_RETENTION === 'long' ? 60 * 60_000 : 5 * 60_000;
}

/** The gate needs the cache to be DEFINITELY cold, so it rounds the TTL UP by a 1-minute buffer.
 *  (cacheWatch rounds the same TTL DOWN instead — a drop near the boundary is expiry, not a break.) */
export function idleThresholdMs(env: NodeJS.ProcessEnv): number {
  return cacheTtlMs(env) + 60_000;
}

/** Deterministic spill path — the placeholder builds it without any I/O, so the transform stays pure. */
export function toolResultSpillPath(spillDir: string, toolCallId: string): string {
  return join(spillDir, `${toolCallId}.txt`);
}

export function clearedToolResultPlaceholder(spillPath: string, originalBytes: number): string {
  return `[Older tool result cleared to save context. Full output saved at: ${spillPath} — read it with the Read tool if needed. Original size: ${originalBytes} bytes.]`;
}

type ToolResultMessage = Extract<PiAgentMessage, { role: 'toolResult' }>;
type ContentBlock = ToolResultMessage['content'][number];

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
    if (messages[index]?.role !== 'user') continue;
    seen += 1;
    if (seen === KEEP_USER_TURNS) return index;
  }
  return -1;
}

export interface ClearableResult {
  index: number;
  toolCallId: string;
  bytes: number;
}

/** Pure selection: which tool results may be cleared on this pass. Eligible = toolResult before the
 *  cut, ≥ CLEAR_MIN_BYTES of text, with a toolCallId (no id → no spill path → never cleared), not
 *  already latched. Exported for tests. */
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
    if (!message.toolCallId || alreadyCleared.has(message.toolCallId)) continue;
    const bytes = textBytes(message);
    if (bytes < CLEAR_MIN_BYTES) continue;
    selection.push({ index, toolCallId: message.toolCallId, bytes });
  }
  return selection;
}

/** Pure replacement: swap each selected message's content for the placeholder text block. Input is
 *  never mutated and unselected messages keep their references (idempotence, same contract as
 *  stripHistoricalImages). Exported for tests. */
export function applyToolResultClearing(
  messages: PiAgentMessage[],
  cleared: ReadonlyMap<string, { index: number; placeholder: string }>,
): PiAgentMessage[] {
  let changed = false;
  const next = messages.map((message, index): PiAgentMessage => {
    if (message?.role !== 'toolResult') return message;
    const entry = cleared.get(message.toolCallId);
    if (!entry || entry.index !== index) return message;
    const already = Array.isArray(message.content)
      && message.content.length === 1
      && message.content[0]?.type === 'text'
      && message.content[0].text === entry.placeholder;
    if (already) return message;
    changed = true;
    return { ...message, content: [{ type: 'text', text: entry.placeholder }] };
  });
  return changed ? next : messages;
}

/** Was the cache definitely cold when this turn started? Compare the last user message (the prompt
 *  that opened the current turn) with the message right before it. During an active tool loop the gap
 *  is seconds; after an idle longer than the TTL the gap proves the prefix had expired. Exported for
 *  tests. */
export function cacheColdAtTurnStart(messages: PiAgentMessage[], idleMs: number, now: number): boolean {
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') { lastUser = index; break; }
  }
  if (lastUser <= 0) return false;
  const promptAt = messages[lastUser]?.timestamp;
  const previousAt = messages[lastUser - 1]?.timestamp;
  if (typeof promptAt !== 'number' || typeof previousAt !== 'number') return false;
  // A rehydrated session's prompt is fresh while its history is old; `now` bounds a prompt stamped in
  // the future (clock skew) so the gap can't be inflated beyond the real idle time.
  return Math.min(promptAt, now) - previousAt > idleMs;
}

export interface ToolResultClearingOptions {
  /** Directory the spill files land in; defaults to `<dataDir>/tool-results/<sessionId>`. */
  spillDir?: string;
  /** Idle gate in ms; defaults to idleThresholdMs(process.env). */
  idleMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
  /** Spill writer injection for tests. Receives the absolute path and the full text. */
  writeSpill?: (path: string, text: string) => Promise<void>;
  /** Spill reader injection for tests; null = unreadable/missing. Used to verify an EEXIST survivor. */
  readSpill?: (path: string) => Promise<string | null>;
}

async function defaultWriteSpill(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, { flag: 'wx' });
}

async function defaultReadSpill(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch { return null; }
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
  const spillDir = options.spillDir ?? toolResultSpillDir(process.env, sessionId);
  const idleMs = options.idleMs ?? idleThresholdMs(process.env);
  const now = options.now ?? Date.now;
  const writeSpill = options.writeSpill ?? defaultWriteSpill;
  const readSpill = options.readSpill ?? defaultReadSpill;
  /** Cleared toolCallId → its original text size in bytes. The latch is what makes the egress prefix
   *  byte-stable across requests: once inside, the placeholder never reverts to full content. */
  const latched = new Map<string, number>();
  /** toolCallIds whose spill failed during THIS idle epoch. The gate stays open for a whole turn, so
   *  retrying on the next pass would clear right after THIS pass paid a full re-cache — a warm-prefix
   *  rewrite, the one thing this module must never do. Retries wait for the next gate OPENING. */
  const failedSpills = new Set<string>();
  /** toolCallIds whose spill path is occupied by a DIFFERENT file. `wx` can never overwrite it, so
   *  retrying could only ever warn again — skip permanently (for this session's lifetime). */
  const foreignSpills = new Set<string>();
  let gateWasOpen = false;
  const previous = agent.transformContext;
  agent.transformContext = async (messages, signal) => {
    const base = previous ? await previous(messages, signal) : messages;
    const gateOpen = cacheColdAtTurnStart(base, idleMs, now());
    if (gateOpen && !gateWasOpen) failedSpills.clear();
    gateWasOpen = gateOpen;
    if (gateOpen) {
      const fresh = selectClearableToolResults(base, new Set(latched.keys()));
      for (const item of fresh) {
        if (failedSpills.has(item.toolCallId) || foreignSpills.has(item.toolCallId)) continue;
        const message = base[item.index] as ToolResultMessage;
        const text = (Array.isArray(message.content) ? message.content : [])
          .filter((block: ContentBlock): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
          .map((block) => block.text)
          .join('\n');
        const spillPath = toolResultSpillPath(spillDir, item.toolCallId);
        try {
          await writeSpill(spillPath, text);
          latched.set(item.toolCallId, item.bytes);
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
              latched.set(item.toolCallId, item.bytes);
              continue;
            }
            foreignSpills.add(item.toolCallId);
            log.warn(`tool result spill for ${item.toolCallId} conflicts with a different file on disk — leaving the result in context`);
            continue;
          }
          failedSpills.add(item.toolCallId);
          log.warn(`tool result spill failed for ${item.toolCallId}`, error);
        }
      }
    }
    if (latched.size === 0) return base;
    const cleared = new Map<string, { index: number; placeholder: string }>();
    for (let index = 0; index < base.length; index += 1) {
      const message = base[index];
      if (message?.role !== 'toolResult') continue;
      const originalBytes = latched.get(message.toolCallId);
      if (originalBytes === undefined) continue;
      cleared.set(message.toolCallId, {
        index,
        placeholder: clearedToolResultPlaceholder(
          toolResultSpillPath(spillDir, message.toolCallId),
          originalBytes,
        ),
      });
    }
    return applyToolResultClearing(base, cleared);
  };
}
