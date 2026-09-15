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
 *    2. Once rendered, a block's bytes NEVER change and it is never moved or removed while the turn lives.
 *       That is what makes each provider message stream a byte-for-byte prefix extension of the previous
 *       one, the same invariant live recall pins with byte comparisons. It is also why reminders
 *       accumulate within a turn: re-rendering one at the moving tail would rewrite already-sent bytes.
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

/** Wrap the parts one provider pass produced in the envelope the model sees.
 *
 *  `tool_calls` states where in the turn this reminder was made, so a trail of frozen blocks reads as
 *  checkpoints rather than as contradictions. Provider output may itself carry a literal closing
 *  delimiter, which would end the element early and promote whatever follows to instructions — the same
 *  defence `renderTurnContextFrame` applies. */
export function renderStepContextFrame(parts: readonly string[], info: StepContextInfo): string {
  if (parts.length === 0) return '';
  const body = parts
    .map((part) => part.replace(/<\s*\/\s*step_context\s*>/gi, '[/step_context]'))
    .join('\n');
  return `${FRAME_OPEN} tool_calls="${info.toolCalls}">\n${body}\n${FRAME_CLOSE}`;
}

/** The ordinal of a message among the CANONICAL ones: what a block anchors on, invariant to how many
 *  synthetic blocks are sitting in front of it. -1 for a meta message, which has no ordinal at all. */
function canonicalOrdinals(messages: readonly ContextMessage[]): number[] {
  const ordinals: number[] = [];
  let ordinal = 0;
  for (const message of messages) {
    if (isMetaUserMessage(message)) { ordinals.push(-1); continue; }
    ordinals.push(ordinal);
    ordinal += 1;
  }
  return ordinals;
}

/** The message at a canonical ordinal, or undefined when history no longer reaches that far. */
function messageAtOrdinal(
  messages: readonly ContextMessage[],
  ordinals: readonly number[],
  ordinal: number,
): ContextMessage | undefined {
  for (let index = 0; index < messages.length; index += 1) {
    if (ordinals[index] === ordinal) return messages[index];
  }
  return undefined;
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

/** Rebuild the provider stream with every frozen block back at its canonical boundary, after the run of
 *  synthetic messages that already sits there — so a sibling injector's block stays where it put it and
 *  ours appends behind it, exactly as on the request that first sent it. */
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
  const emitAt = (ordinal: number) => {
    for (const block of byOrdinal.get(ordinal) ?? []) anchored.push(structuredClone(block.frozenMessage));
  };
  let nextOrdinal = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (isMetaUserMessage(message)) { anchored.push(message); continue; }
    // The previous canonical boundary closes here: everything synthetic that followed it has now been
    // pushed, so blocks anchored there go after that run rather than cutting into it.
    emitAt(nextOrdinal - 1);
    anchored.push(message);
    nextOrdinal += 1;
  }
  emitAt(nextOrdinal - 1);
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
    const ordinals = canonicalOrdinals(messages);

    // A new user turn (including a steering message, which opens a new instruction), a shrinking history
    // or a replaced anchor all mean the turn's context was reset anyway: the blocks of the old one are
    // gone from it, so this starts over instead of carrying them onto a transcript that never had them.
    const userCount = messages.reduce((n, m) => (isUserTurn(m) ? n + 1 : n), 0);
    const anchorLost = blocks.some((block) =>
      !isDeepStrictEqual(messageAtOrdinal(messages, ordinals, block.anchorOrdinal), block.anchorMessage));
    const reset = userCount !== lastUserCount || anchorLost || (lastLength >= 0 && messages.length < lastLength);
    lastUserCount = userCount;
    lastLength = messages.length;
    if (reset) {
      blocks = [];
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
    let anchorMessage: ContextMessage | undefined;
    let anchorOrdinal = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const ordinal = ordinals[index];
      const message = messages[index];
      if (ordinal === undefined || ordinal < 0 || !message) continue;
      anchorMessage = message;
      anchorOrdinal = ordinal;
      break;
    }
    if (!anchorMessage) return reEmit();
    const content = renderStepContextFrame(parts, info);
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
    });
    return insertFrozenBlocks(messages, blocks);
  });
}
