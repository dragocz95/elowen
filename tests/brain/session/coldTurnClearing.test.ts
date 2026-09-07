import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../../../src/store/db.js';
import { BrainStore, type ClearedToolResultRow } from '../../../src/store/brainStore.js';
import { rehydrate, storedContextMessages } from '../../../src/brain/persistence.js';
import {
  clearColdToolResults,
  type ColdToolResultClearingDeps,
  type ColdToolResultSession,
} from '../../../src/brain/session/coldToolResultClearing.js';
import {
  CLEAR_MIN_BYTES,
  KEEP_USER_TURNS,
  TURN_START_KEEP_USER_TURNS,
  clearedToolResultDetails,
  isClearedToolResult,
  selectClearableToolResults,
} from '../../../src/brain/session/toolResultClearing.js';
import { HISTORY_IMAGE_PLACEHOLDER, type PiAgentMessage } from '../../../src/brain/session/historyImageStripping.js';
import { markImagesRejected, resetImageRejections } from '../../../src/brain/session/imageRejection.js';
import { providerPayloadHarness } from '../../helpers/providerPayloads.js';

/** The time trigger, moved from the egress transform to the START of the turn.
 *
 *  What that buys is the whole point of the change: the spill, the transcript row and the live message
 *  are written in one pass, so a respawn, an export and a fork seed all rebuild exactly what the parent's
 *  next request sends. The egress pass could only ever rewrite the copy PI was about to serialize, which
 *  is why it needed a per-session latch to stay byte-stable — and why the store disagreed with the wire
 *  for every result it had cleared.
 *
 *  RED BEFORE THE CHANGE: `clearColdToolResults` did not exist. The row was rewritten from inside the
 *  transform, the live message was never touched at all, and the gate consulted no quiescence predicate,
 *  so a running fork child re-warming its parent's prefix could not hold the rewrite off. */

const SESSION = 's-cold';
const HOUR = 60 * 60_000;
const BIG = 'x'.repeat(CLEAR_MIN_BYTES + 500);

let stores: BrainStore[] = [];
afterEach(() => { stores = []; });

function freshStore(): BrainStore {
  const store = new BrainStore(openDb(':memory:'));
  store.createSession({ id: SESSION, userId: 7, model: 'm' });
  stores.push(store);
  return store;
}

const user = (text: string, timestamp: number): PiAgentMessage =>
  ({ role: 'user', content: [{ type: 'text', text }], timestamp } as PiAgentMessage);

const toolResult = (toolCallId: string, text: string, timestamp: number, details: unknown = { exitCode: 0 }): PiAgentMessage =>
  ({
    role: 'toolResult', toolCallId, toolName: 'Bash', isError: false, timestamp, details,
    content: [{ type: 'text', text }],
  } as PiAgentMessage);

const calling = (toolCallId: string, timestamp: number): PiAgentMessage =>
  ({ role: 'assistant', timestamp, content: [{ type: 'toolCall', id: toolCallId, name: 'Bash', arguments: {} }] } as PiAgentMessage);

/** Three user turns, as a turn START sees the conversation: the user's new message has not been admitted
 *  yet. The newest turn's result is retained; the two older ones are eligible. Each result is introduced
 *  by its own tool call, or a rehydration would drop it as an orphan. */
function history(): PiAgentMessage[] {
  return [
    user('one', 1_000), calling('call-a', 1_050), toolResult('call-a', BIG, 1_100),
    user('two', 2_000), calling('call-b', 2_050), toolResult('call-b', BIG, 2_100),
    user('three', 3_000), calling('call-kept', 3_050), toolResult('call-kept', BIG, 3_100),
  ];
}

function seedRows(store: BrainStore, messages: readonly PiAgentMessage[]): void {
  messages.forEach((message, index) => {
    store.appendMessage({
      id: `m${index}`, sessionId: SESSION, parentId: null,
      role: (message as { role: string }).role, content: message,
    });
  });
}

interface Live { streaming?: boolean; compacting?: boolean; children?: boolean }

function deps(store: BrainStore, live: Live = {}): ColdToolResultClearingDeps {
  return {
    store,
    sessions: {
      // A live record must exist for the quiescence predicate to report anything at all.
      get: () => ({ session: { isStreaming: live.streaming ?? false, getSteeringMessages: () => [], getFollowUpMessages: () => [] } }),
      isParentAborting: () => false,
      hasPendingAbort: () => false,
      hasActiveChildren: () => live.children ?? false,
    },
    elicitation: { pendingForSession: () => null },
  };
}

function session(messages: PiAgentMessage[], live: Live = {}): ColdToolResultSession {
  return {
    session: { messages, isStreaming: live.streaming ?? false, isCompacting: live.compacting ?? false },
    sessionId: SESSION,
    lastRequestCacheTtlMs: HOUR,
  };
}

/** Far enough past the rows' own creation time that the gate is provably open. */
const cold = (): number => Date.now() + 2 * HOUR;
const warm = (): number => Date.now();

const contentOf = (message: PiAgentMessage): { type: string; text?: string }[] =>
  (message as { content: { type: string; text?: string }[] }).content;

const rowContentOf = (store: BrainStore, id: string): { content: { text?: string }[]; details?: unknown } =>
  JSON.parse(store.getMessages(SESSION).find((row) => row.id === id)!.content);

function spillFake(): { files: Map<string, string>; options: { spillDir: string; writeSpill: (p: string, t: string) => Promise<void>; readSpill: (p: string) => Promise<string | null> } } {
  const files = new Map<string, string>();
  return {
    files,
    options: {
      spillDir: '/tmp/cold-spill',
      writeSpill: async (p, t) => {
        if (files.has(p)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        files.set(p, t);
      },
      readSpill: async (p) => files.get(p) ?? null,
    },
  };
}

describe('clearColdToolResults', () => {
  it('writes the spill, the rows and the live messages in one pass', async () => {
    const store = freshStore();
    const messages = history();
    seedRows(store, messages);
    const spill = spillFake();

    await clearColdToolResults(deps(store), session(messages), { ...spill.options, now: cold });

    // The full output reached disk under a name the placeholder quotes, so nothing is lost.
    const path = `/tmp/cold-spill/call-a.v1-time-${BIG.length}.txt`;
    expect(spill.files.get(path)).toBe(BIG);
    // The live message was mutated IN PLACE — same object, new content, marker in its details.
    expect(contentOf(messages[2]!)[0]!.text).toContain(path);
    expect(contentOf(messages[2]!)[0]!.text).toContain('Older tool result cleared');
    expect(isClearedToolResult(messages[2])).toBe(true);
    expect((messages[2] as { details: Record<string, unknown> }).details.exitCode).toBe(0);
    // …and the row says exactly the same thing, which is what a respawn and a fork seed read.
    expect(rowContentOf(store, 'm2').content[0]!.text).toBe(contentOf(messages[2]!)[0]!.text);
    expect(isClearedToolResult(rowContentOf(store, 'm2'))).toBe(true);
  });

  /** The retention must not move by a whole user turn. The egress pass ran with the new user message
   *  already in context and kept two user turns; this one runs before that message is admitted, so it
   *  keeps one. Counting two here would silently retain three turns and clear measurably less. */
  it('selects exactly what the egress pass selected one moment later', async () => {
    const atTurnStart = history();
    const atEgress = [...history(), user('four', 4_000)];
    expect(selectClearableToolResults(atTurnStart, new Set(), TURN_START_KEEP_USER_TURNS).map((r) => r.toolCallId))
      .toEqual(selectClearableToolResults(atEgress, new Set(), KEEP_USER_TURNS).map((r) => r.toolCallId));

    const store = freshStore();
    const messages = history();
    seedRows(store, messages);
    await clearColdToolResults(deps(store), session(messages), { ...spillFake().options, now: cold });
    expect(contentOf(messages[2]!)[0]!.text).toContain('Older tool result cleared');
    expect(contentOf(messages[5]!)[0]!.text).toContain('Older tool result cleared');
    // The newest turn's result is still the model's to read: it has not scrolled far enough back.
    expect(contentOf(messages[8]!)[0]!.text).toBe(BIG);
  });

  it('does nothing while the cache could still be warm', async () => {
    const store = freshStore();
    const messages = history();
    seedRows(store, messages);
    const spill = spillFake();
    await clearColdToolResults(deps(store), session(messages), { ...spill.options, now: warm });
    expect(spill.files.size).toBe(0);
    expect(contentOf(messages[2]!)[0]!.text).toBe(BIG);
  });

  /** A running fork child re-sends its PARENT's prefix on every request, so the parent's cache is warm
   *  while the parent's own rows age past the TTL. "No row in the TTL" is therefore not "no request in
   *  the TTL", and only the quiescence predicate sees the difference. */
  it('does nothing while a child is still running, however cold the rows look', async () => {
    const store = freshStore();
    const messages = history();
    seedRows(store, messages);
    const spill = spillFake();
    await clearColdToolResults(deps(store, { children: true }), session(messages), { ...spill.options, now: cold });
    expect(spill.files.size).toBe(0);
    expect(contentOf(messages[2]!)[0]!.text).toBe(BIG);

    // Control: the very same input clears the moment the child is gone, so the gate above is the reason.
    await clearColdToolResults(deps(store), session(messages), { ...spill.options, now: cold });
    expect(spill.files.size).toBe(2);
  });

  it('does nothing while the session is streaming or compacting', async () => {
    const store = freshStore();
    const spill = spillFake();
    const streaming = history();
    await clearColdToolResults(deps(store), session(streaming, { streaming: true }), { ...spill.options, now: cold });
    const compacting = history();
    await clearColdToolResults(deps(store), session(compacting, { compacting: true }), { ...spill.options, now: cold });
    expect(spill.files.size).toBe(0);
  });

  it('never clears an already cleared result a second time', async () => {
    const store = freshStore();
    // A preview placeholder in a multi-byte script weighs more than the clearing threshold; without the
    // structural marker it would be spilled again and nested inside a second placeholder.
    const placeholder = `[Large tool result (90000 bytes) saved to disk instead of the context. ${'日'.repeat(2_000)}]`;
    const messages: PiAgentMessage[] = [
      user('one', 1_000),
      toolResult('call-cleared', placeholder, 1_100,
        clearedToolResultDetails({}, { mode: 'preview', bytes: 90_000, path: '/tmp/cold-spill/x.txt' })),
      user('two', 2_000),
    ];
    seedRows(store, messages);
    const spill = spillFake();
    await clearColdToolResults(deps(store), session(messages), { ...spill.options, now: cold });
    expect(spill.files.size).toBe(0);
    expect(contentOf(messages[1]!)[0]!.text).toBe(placeholder);
  });

  it('rewrites every row in a single store call', async () => {
    const store = freshStore();
    const messages = history();
    seedRows(store, messages);
    const calls: ClearedToolResultRow[][] = [];
    const spy = Object.create(store) as BrainStore;
    spy.clearToolResultRows = (id, entries) => {
      calls.push([...entries]);
      return store.clearToolResultRows(id, entries);
    };
    await clearColdToolResults(deps(spy), session(messages), { ...spillFake().options, now: cold });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.map((entry) => entry.toolCallId)).toEqual(['call-a', 'call-b']);
  });

  it('leaves a result whole when its spill cannot be written, and clears the rest', async () => {
    const store = freshStore();
    const messages = history();
    seedRows(store, messages);
    const files = new Map<string, string>();
    await clearColdToolResults(deps(store), session(messages), {
      spillDir: '/tmp/cold-spill',
      now: cold,
      writeSpill: async (p, t) => {
        if (p.includes('call-a')) throw Object.assign(new Error('readonly'), { code: 'EACCES' });
        files.set(p, t);
      },
      readSpill: async (p) => files.get(p) ?? null,
    });
    expect(contentOf(messages[2]!)[0]!.text).toBe(BIG); // the one that failed keeps its output
    expect(contentOf(messages[5]!)[0]!.text).toContain('Older tool result cleared');
    expect(rowContentOf(store, 'm2').content[0]!.text).toBe(BIG);
  });

  it('never throws, whatever the store does', async () => {
    const store = freshStore();
    const messages = history();
    seedRows(store, messages);
    const broken = Object.create(store) as BrainStore;
    broken.clearToolResultRows = () => { throw new Error('disk full'); };
    await expect(clearColdToolResults(deps(broken), session(messages), { ...spillFake().options, now: cold }))
      .resolves.toBeUndefined();
  });

  it('makes a respawn and a fork seed read what the live context now holds', async () => {
    const store = freshStore();
    const messages = history();
    seedRows(store, messages);
    await clearColdToolResults(deps(store), session(messages), { ...spillFake().options, now: cold });

    const replayed = rehydrate(store, SESSION, process.cwd()).buildSessionContext().messages as { content: unknown }[];
    const seeded = storedContextMessages(store, SESSION);
    for (const [index, message] of messages.entries()) {
      expect(replayed[index]?.content).toEqual((message as { content: unknown }).content);
      expect(seeded[index]?.content).toEqual((message as { content: unknown }).content);
    }
    // Everything before the retained turn is a placeholder now, so a fork child inherits the parent's
    // size rather than the megabytes the parent had already stopped sending.
    expect(JSON.stringify(seeded.slice(0, 6))).not.toContain(BIG);
  });
});

describe('historical images at a cold turn start', () => {
  const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' } as const;
  const withImage = (): PiAgentMessage[] => [
    { role: 'user', content: [{ type: 'text', text: 'look' }, image], timestamp: 1_000 } as PiAgentMessage,
    user('two', 2_000),
  ];
  const blocksOf = (message: PiAgentMessage): { type: string }[] =>
    (message as { content: { type: string }[] }).content;

  afterEach(() => { resetImageRejections(); });

  it('are collapsed in the live context, which is what the stored row already replays', async () => {
    const store = freshStore();
    const messages = withImage();
    seedRows(store, messages);
    await clearColdToolResults(deps(store), session(messages), { ...spillFake().options, now: cold });
    expect(blocksOf(messages[0]!)).toEqual([
      { type: 'text', text: 'look' },
      { type: 'text', text: HISTORY_IMAGE_PLACEHOLDER },
    ]);
  });

  it('stay while the cache could still be warm', async () => {
    const store = freshStore();
    const messages = withImage();
    seedRows(store, messages);
    await clearColdToolResults(deps(store), session(messages), { ...spillFake().options, now: warm });
    expect(blocksOf(messages[0]!).some((block) => block.type === 'image')).toBe(true);
  });

  /** A refused image is permanent poison: it goes out with every later request and fails each one, so it
   *  cannot wait for the gate — the conversation would answer the same error for a full hour. */
  it('go immediately once the provider has refused one, gate or no gate', async () => {
    const store = freshStore();
    const messages = withImage();
    seedRows(store, messages);
    markImagesRejected(SESSION);
    await clearColdToolResults(deps(store), session(messages), { ...spillFake().options, now: warm });
    expect(blocksOf(messages[0]!).some((block) => block.type === 'image')).toBe(false);
  });

  /** OpenAI may hold an inactive prompt cache for a full hour whatever retention the request declared, so
   *  the destructive image pass uses that upper bound rather than the TTL pi-ai asked for. */
  it('wait for the longest retention any provider uses, not just the declared TTL', async () => {
    const store = freshStore();
    const messages = withImage();
    seedRows(store, messages);
    const shortTtl: ColdToolResultSession = {
      ...session(messages), lastRequestCacheTtlMs: 5 * 60_000,
    };
    // Seven minutes: past the declared five-minute TTL, nowhere near the hour OpenAI may still be serving.
    await clearColdToolResults(deps(store), shortTtl, {
      ...spillFake().options, now: () => Date.now() + 7 * 60_000,
    });
    expect(blocksOf(messages[0]!).some((block) => block.type === 'image')).toBe(true);
  });
});

describe('what the provider request carries afterwards', () => {
  /** The assertion that matters for the cache: a WARM turn must send a byte-identical prefix, because a
   *  single differing byte re-caches the whole conversation. A cold one may differ — and only there. */
  it('is byte-identical while warm and carries the placeholder once cold', async () => {
    const store = freshStore();
    const harness = await providerPayloadHarness();
    // Seed the live session with the same history the store holds, as a respawn would.
    const messages = history();
    seedRows(store, messages);
    for (const message of messages) harness.session.messages.push(message as never);

    const first = (await harness.prompt('again'))[0]!;
    await clearColdToolResults(deps(store), session(harness.session.messages as PiAgentMessage[]),
      { ...spillFake().options, now: warm });
    const second = (await harness.prompt('and again'))[0]!;
    // Compare everything but each request's own last message: pi-ai marks the final block for caching,
    // and that marker legitimately moves forward with every turn. Everything before it is the cached
    // prefix, and a single differing byte there re-caches the whole conversation.
    expect(JSON.stringify(second.messages.slice(0, first.messages.length - 1)))
      .toBe(JSON.stringify(first.messages.slice(0, -1)));

    await clearColdToolResults(deps(store), session(harness.session.messages as PiAgentMessage[]),
      { ...spillFake().options, now: cold });
    const third = (await harness.prompt('once more'))[0]!;
    expect(JSON.stringify(third.messages)).not.toContain(BIG);
    expect(JSON.stringify(third.messages)).toContain('Older tool result cleared');
  });
});
