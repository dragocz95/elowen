import { isDeepStrictEqual } from 'node:util';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { PiAgentMessage } from './historyImageStripping.js';
import { isMetaUserMessage, isUserTurn } from './userTurn.js';
import { logger } from '../../shared/logger.js';

/** Per-step plugin context: what `registerTurnContext` is to a prompt turn, this is to a STEP inside one.
 *
 *  Turn-context providers run only while a fresh prompt is composed, so a 60-call turn reads its task list,
 *  its clock and its live subsystems once and then works against that frozen snapshot. This seam calls a
 *  plugin's provider again mid-turn — after the last tool result, every N tool calls — over pi's `context`
 *  event, which fires before EVERY model request.
 *
 *  Two rules are load-bearing rather than stylistic, and both come from prompt caching:
 *
 *    1. A block is anchored after a fixed CANONICAL message and re-emitted there on every later request.
 *       The anchor is a canonical ordinal (how many non-meta messages precede it) and not a raw index,
 *       because this handler runs after {@link installLiveRecall} in the chain and sees that injector's
 *       synthetic blocks too — a raw index would move when a sibling inserts one and read as a compaction.
 *    2. Once rendered, a block's bytes NEVER change and it is never moved or removed until a COMPACTION.
 *       That is what makes each provider message stream a byte-for-byte prefix extension of the previous
 *       one, the same invariant live recall pins with byte comparisons. It is also why reminders
 *       accumulate: re-rendering one at the moving tail would rewrite already-sent bytes.
 *
 *       A turn boundary is explicitly NOT such a moment. PI does not reset its message history when a new
 *       user message arrives — the conversation keeps growing and the provider keeps reading the same
 *       cached prefix — so dropping a block there removes a message from the MIDDLE of what was already
 *       sent and invalidates every entry from its anchor onward. A new user message therefore restarts the
 *       CADENCE (it opens a new instruction) and nothing else; only a compaction, which destroys the prefix
 *       anyway, clears the trail. Live recall reaches the same conclusion at `liveRecall.ts:299-316`.
 *
 *  Nothing returned here is persisted: pi clones canonical history per request and chains the `context`
 *  handlers over each other's output, so a reminder reaches the model and nothing else — not the
 *  transcript, the CLI, the web chat or a platform message. */

export interface StepContextInfo {
  /** Tool calls the model has made in this turn so far. */
  toolCalls: number;
}

/** What one plugin's provider does: read some live state and say something short about it. */
export type StepContextRenderer = (info: StepContextInfo) => string | Promise<string>;

/** A registered provider, as core consumes it. Structurally the plugin surface's `StepContextContribution`,
 *  which is what lets the spawner hand the registry's own list straight to a session. */
export interface StepContextProvider {
  render: StepContextRenderer;
}

export interface StepContextOptions {
  /** Durable conversation identity, written to the log line and nothing else. */
  sessionId: string;
  /** How many tool calls pass between two reminders. Read per pass, never latched: the operator may move
   *  the slider mid-conversation. The slider's floor is 10, so a value below it means the dependency is
   *  unwired and the seam stays off rather than spamming a reminder on every step. */
  every: () => number;
  /** The registered providers, in registration order, resolved per pass so a plugin reload is picked up. */
  providers: () => readonly StepContextProvider[];
}

/** A message as pi hands it to the context hook. Only the fields this module reads are named. */
interface ContextMessage {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
}

/** One reminder already sent, frozen with the canonical boundary it was sent at. */
interface FrozenBlock {
  /** How many NON-meta messages preceded the anchor when this block was emitted. */
  anchorOrdinal: number;
  /** Deep clone of the anchor message, so a replacement or compaction is detected even at the same length. */
  anchorMessage: ContextMessage;
  frozenMessage: Readonly<ContextMessage>;
}

const FRAME_OPEN = '<step_context';
const FRAME_CLOSE = '</step_context>';
const TRUNCATION_MARK = '\n…[truncated]';

/** Ceiling on one reminder's body. Every byte here is FROZEN and re-sent on every later request of the
 *  conversation until a compaction, so an unbounded provider does not merely make one prompt long — it
 *  inflates every request that follows, permanently. The API doc comment asks a provider for a few hundred
 *  bytes; this is what keeps core safe from one that ignores it, the way `memoryLiveRecallBytes` bounds the
 *  sibling injector. Generous enough that no honest reminder ever meets it. */
export const STEP_CONTEXT_MAX_BYTES = 1024;

/** Cut `text` to at most `max` BYTES without splitting a character. A raw byte slice can land inside a
 *  multi-byte sequence, which decodes to a replacement character and hands the provider a corrupted tail;
 *  the incomplete sequence is dropped instead. */
function clampToBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  const room = max - Buffer.byteLength(TRUNCATION_MARK);
  const cut = Buffer.from(text).subarray(0, room).toString('utf8');
  const whole = cut.endsWith('\uFFFD') ? cut.slice(0, -1) : cut;
  return `${whole}${TRUNCATION_MARK}`;
}

/** Wrap the parts one provider pass produced in the envelope the model sees.
 *
 *  `tool_calls` states where in the turn this reminder was made, so a trail of frozen blocks reads as
 *  checkpoints rather than as contradictions. Provider output may itself carry a literal closing
 *  delimiter, which would end the element early and promote whatever follows to instructions — the same
 *  defence `renderTurnContextFrame` applies.
 *
 *  `truncated` is reported rather than kept quiet: a clamped reminder and a provider that simply had
 *  little to say are otherwise the same bytes in the log, and they need different fixes. */
export function renderStepContextFrame(
  parts: readonly string[],
  info: StepContextInfo,
): { content: string; truncated: boolean } {
  if (parts.length === 0) return { content: '', truncated: false };
  const rendered = parts
    .map((part) => part.replace(/<\s*\/\s*step_context\s*>/gi, '[/step_context]'))
    .join('\n');
  const body = clampToBytes(rendered, STEP_CONTEXT_MAX_BYTES);
  return {
    content: `${FRAME_OPEN} tool_calls="${info.toolCalls}">\n${body}\n${FRAME_CLOSE}`,
    truncated: body !== rendered,
  };
}

/** The CANONICAL messages in order, indexed by their ordinal: what a block anchors on, invariant to how
 *  many synthetic blocks a sibling injector has put in front of them. Built once per pass so re-finding an
 *  anchor costs one array read rather than a scan — the trail now outlives a turn, so this runs against
 *  every block of the conversation on every model request. */
function canonicalMessages(messages: readonly ContextMessage[]): ContextMessage[] {
  const canonical: ContextMessage[] = [];
  for (const message of messages) {
    if (!isMetaUserMessage(message)) canonical.push(message);
  }
  return canonical;
}

/** How many tool calls the model has made since the turn's last real user message. A parallel batch
 *  counts each call, because the unit the operator's knob is set in is a call, not a round trip. */
function countTurnToolCalls(messages: readonly ContextMessage[]): number {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isUserTurn(messages[index])) { lastUserIndex = index; break; }
  }
  let calls = 0;
  for (let index = lastUserIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if ((part as { type?: unknown })?.type === 'toolCall') calls += 1;
    }
  }
  return calls;
}

/** Rebuild the provider stream with every frozen block back at its canonical boundary — IMMEDIATELY after
 *  the canonical message it was anchored to, ahead of whatever synthetic messages follow it.
 *
 *  Ahead, not behind, and that is the whole point. A sibling injector anchors at the last canonical message
 *  too, and it can add a block there on a later pass without the canonical history moving at all: a durable
 *  harness retry re-runs this hook over the same messages, and live recall injects a settled retrieval on
 *  exactly such a pass. Placing ours behind the synthetic run would let that newcomer push our already-sent
 *  block one position later — an insertion in the middle of bytes the provider has cached. Placed here,
 *  every later sibling block lands BEHIND ours and the payload stays a pure append. */
function insertFrozenBlocks(
  messages: readonly ContextMessage[],
  blocks: readonly FrozenBlock[],
): { messages: PiAgentMessage[] } {
  const byOrdinal = new Map<number, FrozenBlock[]>();
  for (const block of blocks) {
    const list = byOrdinal.get(block.anchorOrdinal);
    if (list) list.push(block);
    else byOrdinal.set(block.anchorOrdinal, [block]);
  }
  const anchored: ContextMessage[] = [];
  let ordinal = 0;
  for (const message of messages) {
    if (!message) continue;
    anchored.push(message);
    if (isMetaUserMessage(message)) continue;
    for (const block of byOrdinal.get(ordinal) ?? []) anchored.push(structuredClone(block.frozenMessage));
    ordinal += 1;
  }
  return { messages: anchored as unknown as PiAgentMessage[] };
}

export function installStepContext(pi: ExtensionAPI, opts: StepContextOptions): void {
  const log = logger('brain-step-context');
  let blocks: FrozenBlock[] = [];
  /** Tool-call count when the providers last ran. Recorded even when every one of them answered `''`, so
   *  an empty answer costs one cadence, not one step. */
  let lastFiredAt = 0;
  let lastUserCount = -1;
  let lastLength = -1;
  let loggedSkip = false;

  pi.on('context', async (event) => {
    const messages = (event.messages ?? []) as unknown as ContextMessage[];
    const canonical = canonicalMessages(messages);

    // Two DIFFERENT events, deliberately not merged into one "reset".
    //
    // A compaction — a shrinking history, or an anchored canonical message that is no longer the message
    // it was — replaced the transcript. The blocks this seam sent are gone from it, the cached prefix is
    // gone with them, and carrying them onto the replacement would both stale the context and invent a
    // boundary nothing wrote. So the trail is cleared, and ONLY here.
    //
    // A new user message is not that. PI keeps the same growing history across a turn boundary, so
    // dropping the trail there would delete messages from the middle of a prefix the provider has cached.
    // What a new instruction does change is the cadence: `countTurnToolCalls` restarts at it, so the
    // fired-at mark has to restart with it or the next reminder would wait for a count that never comes.
    const userCount = messages.reduce((n, m) => (isUserTurn(m) ? n + 1 : n), 0);
    const anchorLost = blocks.some((block) =>
      !isDeepStrictEqual(canonical[block.anchorOrdinal], block.anchorMessage));
    const compacted = anchorLost || (lastLength >= 0 && messages.length < lastLength);
    const newInstruction = userCount !== lastUserCount;
    lastUserCount = userCount;
    lastLength = messages.length;
    if (compacted) blocks = [];
    if (compacted || newInstruction) {
      lastFiredAt = 0;
      loggedSkip = false;
    }

    const reEmit = (): { messages: PiAgentMessage[] } | undefined =>
      (blocks.length > 0 ? insertFrozenBlocks(messages, blocks) : undefined);

    const every = opts.every();
    if (every <= 0) {
      // Say it once per turn. An unwired `runtimeConfig` dependency is indistinguishable from a feature
      // that simply had nothing to say, and that ambiguity already cost live recall a production
      // debugging round.
      if (!loggedSkip) {
        loggedSkip = true;
        log.info('off this turn', { sessionId: opts.sessionId, everyToolCalls: every });
      }
      return reEmit();
    }

    const toolCalls = countTurnToolCalls(messages);
    if (toolCalls - lastFiredAt < every) return reEmit();
    lastFiredAt = toolCalls;

    const info: StepContextInfo = { toolCalls };
    const parts: string[] = [];
    for (const provider of opts.providers()) {
      // Each provider is isolated the way turn-context providers are: one that throws, rejects or returns
      // nothing contributes nothing, and the turn runs on. A conversation with no task list, or a
      // read-only child with no task tools, therefore injects nothing at all.
      try {
        const value = await provider.render(info);
        if (typeof value === 'string' && value.trim()) parts.push(value);
      } catch {
        /* A broken optional provider must not fail the turn. */
      }
    }
    if (parts.length === 0) return reEmit();

    // The anchor is the LAST canonical message, so the reminder trails everything the turn has actually
    // produced. Its ordinal — not its index — is what a later request re-finds it by.
    const anchorOrdinal = canonical.length - 1;
    const anchorMessage = canonical[anchorOrdinal];
    if (!anchorMessage) return reEmit();
    const { content, truncated } = renderStepContextFrame(parts, info);
    blocks = [...blocks, {
      anchorOrdinal,
      anchorMessage: structuredClone(anchorMessage),
      frozenMessage: Object.freeze({ role: 'user', content, isMeta: true }),
    }];

    // The only positive signal the seam fired at all: content-free by construction, because what it
    // injected is prompt text and prompt text does not belong in a log line.
    log.info('reminded mid-turn', {
      sessionId: opts.sessionId,
      toolCalls,
      providers: parts.length,
      bytes: Buffer.byteLength(content),
      truncated,
    });
    return insertFrozenBlocks(messages, blocks);
  });
}
