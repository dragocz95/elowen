import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { openDb, type Db } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { BrainSessionFactory } from '../../src/brain/session/factory.js';
import {
  projectTurnWireFrames, projectUserTurn, rehydrate, rehydrateWithTimestamps, storedContextMessages,
} from '../../src/brain/persistence.js';
import { composeTurnWire } from '../../src/brain/session/turnPrompt.js';
import { renderTurnContextFrame } from '../../src/brain/session/turnContextFrame.js';
import { shapeBrainMessages } from '../../src/brain/messageView.js';
import { FORK_EXECUTE_DENIES, forkSeedMessages, type ForkMessage } from '../../src/brain/session/forkPrefix.js';
import { delegatedToolPolicy, delegatedVisibilityToolPolicy, type DelegatedExecutionScope } from '../../src/brain/delegatedScope.js';
import { visibleToolNames } from '../../src/brain/session/capabilities.js';
import { HISTORY_IMAGE_PLACEHOLDER } from '../../src/brain/session/historyImageStripping.js';
import { createToolSearchHandle, seedActivatedFromHistory } from '../../src/brain/toolSearch/toolSearchTool.js';
import {
  anthropicHostedReplayMetadata,
  restoreAnthropicHostedReplay,
  verifyAnthropicHostedReplay,
} from '../../src/brain/session/anthropicHostedToolReplay.js';
import { clearColdToolResults } from '../../src/brain/session/coldToolResultClearing.js';
import { providerPayloadHarness } from '../helpers/providerPayloads.js';
import { anthropicWire } from '../helpers/anthropicWire.js';

/** The quiescence dependencies of a session with nothing in flight — the turn-start pass's only inputs
 *  besides the store itself. */
const coldDeps = (store: BrainStore): never => ({
  store,
  sessions: {
    get: () => ({ session: { isStreaming: false, getSteeringMessages: () => [], getFollowUpMessages: () => [] } }),
    isParentAborting: () => false, hasPendingAbort: () => false, hasActiveChildren: () => false,
  },
  elicitation: { pendingForSession: () => null },
}) as never;

/** A fork child must start from what its parent's next request WOULD send, byte for byte. That is a
 *  stronger claim than "the same rows": between the stored rows and the wire sit the transforms this
 *  conversation has already applied — a cleared tool result, an image that moved to disk, a compaction
 *  that rewrote history — and a seed that carries any of them back is a different conversation, not a
 *  cheaper fork. It is also a bigger one: the fork that motivated this test seeded 2.4 MB where its
 *  parent was sending far less, and the request died at the transport.
 *
 *  The fix is that there is only ONE reading of "what this conversation currently is" —
 *  `storedContextMessages`, the same generator a rehydration replays — and the fork seed goes through it.
 *  These tests pin each transform that used to leak through, plus the tool activation a replayed
 *  `tool_reference` depends on.
 *
 *  RED BEFORE THE FIX: the previous seed read `store.getMessages` and JSON-parsed each row itself, so the
 *  cleared result came back at full size, the externalized image came back as an image block, and an
 *  orphaned tool result came back to be rejected by the provider. Reverting `parentForkHistory` to that
 *  reading fails the first three assertions here. */

/** One parent turn in which Anthropic's SERVER-side search pulled a deferred tool in. The reference names
 *  `WorkflowStart`, which is exactly the name the deployed 400 named. */
const HOSTED_CONTENT = [
  { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_bm25', input: { query: 'workflow' } },
  {
    type: 'tool_search_tool_result',
    tool_use_id: 'srvtoolu_1',
    content: { type: 'tool_search_tool_search_result', tool_references: [{ type: 'tool_reference', tool_name: 'WorkflowStart' }] },
  },
  { type: 'text', text: 'searched' },
];

/** The same shape, naming a tool a fork child is allowed to SEE but never to run — the name the
 *  production fork actually lost out of its replayed history. */
const SHARE_CONTENT = [
  { type: 'server_tool_use', id: 'srvtoolu_2', name: 'tool_search_tool_bm25', input: { query: 'share' } },
  {
    type: 'tool_search_tool_result',
    tool_use_id: 'srvtoolu_2',
    content: { type: 'tool_search_tool_search_result', tool_references: [{ type: 'tool_reference', tool_name: 'ShareImage' }] },
  },
  { type: 'text', text: 'shared' },
];

const OUTPUT = 'x'.repeat(50_007);
const PLACEHOLDER = '[Large tool result (50007 bytes) saved to disk instead of the context. '
  + 'Full output at: /data/tool-results/s-parent/call-bash.v1-preview-50007.txt — read it with the Read '
  + 'tool if needed. First 20 characters below.]\nxxxxxxxxxxxxxxxxxxxx';

describe('the transcript a fork inherits', () => {
  let db: Db;
  let store: BrainStore;
  let row = 0;

  const append = (role: string, content: unknown): void => {
    row += 1;
    store.appendMessage({ id: `m${row}`, sessionId: 's-parent', parentId: null, role, content });
  };

  beforeEach(() => {
    row = 0;
    db = openDb(':memory:');
    store = new BrainStore(db);
    store.createSession({ id: 's-parent', userId: 7, model: 'anthropic/big' });

    // A ToolSearch that ACTIVATED a deferred tool. The child has to rebuild this or its replayed
    // tool references name tools its own request does not carry.
    append('user', { role: 'user', content: [{ type: 'text', text: 'first' }], timestamp: 1_000 });
    append('assistant', {
      role: 'assistant', timestamp: 1_100,
      content: [{ type: 'toolCall', id: 'call-search', name: 'ToolSearch', arguments: {} }],
    });
    append('toolResult', {
      role: 'toolResult', toolCallId: 'call-search', toolName: 'ToolSearch', isError: false,
      timestamp: 1_200, details: { matched: ['WorkflowStart'] },
      content: [{ type: 'text', text: 'Activated WorkflowStart' }],
    });
    // A compaction divider, replayed as a compaction entry rather than an ordinary message.
    append('compactionSummary', { role: 'compactionSummary', summary: 'earlier work', tokensBefore: 120_000 });
    // A user message whose image has moved to disk.
    append('user', {
      role: 'user', timestamp: 2_000,
      content: [{ type: 'text', text: 'look' }, { type: 'image', ref: { path: '/data/chat-images/a.png' }, mimeType: 'image/png' }],
    });
    // A large tool result that egress has since cleared.
    append('assistant', {
      role: 'assistant', timestamp: 2_100,
      content: [{ type: 'toolCall', id: 'call-bash', name: 'Bash', arguments: {} }],
    });
    append('toolResult', {
      role: 'toolResult', toolCallId: 'call-bash', toolName: 'Bash', isError: false,
      timestamp: 2_200, content: [{ type: 'text', text: OUTPUT }],
    });
    store.clearToolResultRows('s-parent', [{
      toolCallId: 'call-bash', occurredAt: 2_200, placeholder: PLACEHOLDER,
    }]);
  });

  const seed = (): ForkMessage[] => forkSeedMessages(storedContextMessages(store, 's-parent') as ForkMessage[], 9_000);

  it('carries the cleared tool result as its placeholder, not as the output it replaced', () => {
    const cleared = seed().find((message) => message.toolCallId === 'call-bash');
    expect(cleared?.content).toEqual([{ type: 'text', text: PLACEHOLDER }]);
    expect(JSON.stringify(seed())).not.toContain(OUTPUT);
  });

  it('carries an externalized image as the same placeholder the stripper writes', () => {
    const message = seed().find((m) => Array.isArray(m.content)
      && (m.content as { text?: string }[]).some((block) => block.text === 'look'));
    expect(message?.content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'text', text: HISTORY_IMAGE_PLACEHOLDER },
    ]);
  });

  it('is exactly what a rehydration of the same conversation replays', () => {
    // The one property the whole design rests on: seed and respawn read the SAME function, so a child
    // that is restarted, evicted or boot-recovered rebuilds the prefix it started with.
    const replayed = (rehydrate(store, 's-parent', process.cwd()).buildSessionContext().messages as {
      role: string; content: unknown;
    }[]).filter((message) => message.role !== 'compactionSummary');
    // A replayed context starts at the compaction boundary, while the seed carries the whole transcript
    // (the child's own replay applies the same cut). Compare what both sides do hold: the kept tail.
    const seeded = seed().filter((message) => message.role !== 'compactionSummary').slice(-replayed.length);
    expect(seeded.map((message) => message.role)).toEqual(replayed.map((message) => message.role));
    for (const [index, message] of replayed.entries()) {
      expect(seeded[index]?.content).toEqual(message.content);
    }
  });

  it('keeps the compaction divider, so the child replays a compacted parent as compacted', () => {
    expect(seed().some((message) => message.role === 'compactionSummary')).toBe(true);
  });

  it('rebuilds the deferred-tool activation a replayed tool reference depends on', () => {
    const handle = createToolSearchHandle(new Set(['WorkflowStart', 'WorkflowResume']));
    seedActivatedFromHistory(handle, seed());
    expect([...handle.activated]).toEqual(['WorkflowStart']);
  });

  it('carries the parent’s hosted-search replay metadata, which the child replays verbatim', () => {
    append('assistant', {
      role: 'assistant', timestamp: 2_300, content: [{ type: 'text', text: 'searched' }],
      anthropicHostedToolReplay: { v: 1, content: HOSTED_CONTENT },
    });
    const replayed = seed().find((message) => (message as { anthropicHostedToolReplay?: unknown }).anthropicHostedToolReplay);
    expect(replayed).toBeDefined();
    expect(anthropicHostedReplayMetadata(replayed as never)?.content).toEqual(HOSTED_CONTENT);
  });

  it('drops a tool result whose call the compaction cut, which the raw rows would hand to the provider', () => {
    append('toolResult', {
      role: 'toolResult', toolCallId: 'call-gone', toolName: 'Read', isError: false,
      timestamp: 3_000, content: [{ type: 'text', text: 'orphan' }],
    });
    expect(seed().some((message) => message.toolCallId === 'call-gone')).toBe(false);
    expect(store.getMessages('s-parent').some((r) => r.content.includes('call-gone'))).toBe(true);
  });
});

/** The golden test, and the two gaps its previous version left open.
 *
 *  It used to compare the seed with a REHYDRATION — a second reading of the same rows, which agrees with
 *  them by construction — and then with a payload the test harness had projected itself, flattening every
 *  message into one text block. Roles, tool call ids, image blocks, the coalescing of tool results and the
 *  whole hosted-replay path were invisible to that comparison, so it could stay green through any of them
 *  breaking.
 *
 *  What a fork actually promises is that the child's FIRST request is what the PARENT'S NEXT request would
 *  have been. So that is what this measures: two real sessions built by the production factory, running the
 *  production extension chain, over pi-ai's own `anthropic-messages` provider pointed at a loopback socket.
 *  The bytes compared are the bytes the provider would have received.
 *
 *  RED BEFORE THE CHANGE: the parent's live context collapsed two adjacent images into ONE placeholder (as
 *  PI's own downgrade does) while the row replay produced one placeholder PER image, so the child's tool
 *  result differed from its parent's in the middle of the cached prefix. */
describe('the first request a fork child sends', () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const GIF = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const OUTPUT = 'y'.repeat(60_000);

  let dirs: string[] = [];
  afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });

  /** A user row is stored as PLAIN TEXT (`projectUserTurn`), while the live message PI builds carries a
   *  text BLOCK, and the converter passes both through as they are. Every rehydration and every fork
   *  therefore sends `content: "hello"` where the original session sent `content: [{type:"text",…}]`.
   *  Asserted on its own below, and normalized here so it cannot mask a second difference. */
  const normalize = (messages: { role: string; content: unknown }[]): unknown[] => messages.map((message) => ({
    ...message,
    content: typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content,
  }));

  it('is byte-identical to the request its parent would have sent', async () => {
    const chatImagesDir = mkdtempSync(join(tmpdir(), 'elowen-fork-images-'));
    const spillDir = mkdtempSync(join(tmpdir(), 'elowen-fork-spill-'));
    dirs.push(chatImagesDir, spillDir);
    const wire = await anthropicWire({
      replyFor: (call) => (call === 1 ? { toolCall: { id: 'call-1', name: 'Shot' } } : { text: 'ok' }),
    });
    try {
      const store = new BrainStore(openDb(':memory:'));
      store.createSession({ id: 's-parent-live', userId: 7, model: 'claude-x' });
      const factory = new BrainSessionFactory({ store, chatImagesDir } as never);
      // One tool result with everything the wire has to survive: text past the delivery-spill trigger and
      // two ADJACENT images, which the live pass and the row replay have to reconstruct the same way.
      const spec = {
        ownerUserId: 7, runtime: wire.runtime, model: wire.model, cwd: process.cwd(),
        systemPrompt: 'sys', appendSystemPrompt: [], skills: [],
        // The Anthropic hosted-search wiring, so the deferred tool block and the raw-replay extension are
        // part of the chain being compared rather than something the test quietly leaves out.
        hostedToolSearch: 'anthropic',
        tools: [defineTool({
          name: 'Shot', label: 'Shot', description: 'Returns a large output and two pictures',
          parameters: Type.Object({}),
          execute: async () => ({
            content: [
              { type: 'text', text: OUTPUT },
              { type: 'image', data: PNG, mimeType: 'image/png' },
              { type: 'image', data: GIF, mimeType: 'image/gif' },
            ],
            details: {},
          }),
        })],
        autoCompact: false, autoCompactAtPct: 80,
      };
      const parent = await factory.create({ ...spec, sessionId: 's-parent-live' } as never);
      projectUserTurn(store, 's-parent-live', 'hello');
      await parent.session.prompt('hello');

      // The turn-start pass the parent's next turn would run: the images collapse in the live context, so
      // this is the exact moment the "live == rows == wire" claim is made.
      await clearColdToolResults(coldDeps(store), {
        session: parent.session as never, sessionId: 's-parent-live', lastRequestCacheTtlMs: 60 * 60_000,
      }, { spillDir, now: () => Date.now() + 3 * 60 * 60_000 });

      const seed = forkSeedMessages(storedContextMessages(store, 's-parent-live') as ForkMessage[], 200_000);
      await parent.session.prompt('again');
      const parentRequest = wire.bodies.at(-1)!;

      const fork = { admin: false, projectIds: [], owner: false, permissionBoundary: null, fork: true };
      store.createSession({
        id: 's-child', userId: 7, model: 'claude-x', parentSessionId: 's-parent-live', delegatedAccess: fork,
      });
      const child = await factory.create({
        ...spec, sessionId: 's-child', parentSessionId: 's-parent-live', delegatedAccess: fork, forkSeed: seed,
      } as never);
      await child.session.prompt('again');
      const childRequest = wire.bodies.at(-1)!;

      // The whole prefix, block for block — not a flattened projection of it.
      expect(normalize(childRequest.messages)).toEqual(normalize(parentRequest.messages));
      // …and the rest of the request the prefix is cached against.
      expect(childRequest.tools).toEqual(parentRequest.tools);
      expect(childRequest.system).toEqual(parentRequest.system);
      // The transforms really did fire, so the equality above is not two untouched histories agreeing.
      const toolResult = JSON.stringify(parentRequest.messages.find((message) => message.role === 'user'
        && Array.isArray(message.content)
        && (message.content as { type: string }[]).some((block) => block.type === 'tool_result')));
      expect(toolResult).toContain('saved to disk instead of the context');
      expect(toolResult).not.toContain(OUTPUT.slice(0, 3_000));
      expect(toolResult).toContain(HISTORY_IMAGE_PLACEHOLDER);
      expect(toolResult).not.toContain(PNG);
      // Exactly ONE placeholder for the two adjacent images, on both sides.
      expect(toolResult.split(HISTORY_IMAGE_PLACEHOLDER)).toHaveLength(2);
    } finally {
      await wire.close();
    }
  }, 60_000);

  /** The one difference the normalization above covers, stated out loud so it stays a known limitation
   *  rather than something the golden test hides: a replayed user message is a bare string where the live
   *  one is a text block. It is not introduced by tool-result clearing — it is how user rows have always
   *  been stored — and every rehydration has it too. */
  it('differs from it in exactly one known place: a replayed user message is a bare string', async () => {
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: 's-shape', userId: 7, model: 'claude-x' });
    projectUserTurn(store, 's-shape', 'hello');
    const seeded = forkSeedMessages(storedContextMessages(store, 's-shape') as ForkMessage[], 200_000);
    expect(seeded[0]?.content).toBe('hello');
  });
});

/** The blocks the parent's request carries that nothing used to write down.
 *
 *  A turn is composed of the user's words plus whatever the runtime wrapped around them — recalled
 *  memories, the permission summary, plugin context frames, a mode directive, a running-sub-agent
 *  reminder. All of it went to the provider inside the user message and none of it reached a row, so a
 *  child seeded from those rows diverged at the FIRST turn that carried any of them and re-billed
 *  everything behind it. In an owner chat with recall on (the default) that is turn one.
 *
 *  RED BEFORE THE FIX: the row held only the user's text, so the seed below is that text alone while the
 *  parent's own next request opens with the memories, the digest and the context frame. Dropping the
 *  `projectTurnWireFrames` call, or reading the rows without the frames, fails the first assertion on the
 *  first message. */
describe('a fork seeded from a turn that carried ephemeral frames', () => {
  const MEMORY = '<user_memories>\nThe owner deploys from one host.\n</user_memories>\n\n';
  const PERMISSIONS = '<permissions>\nBash: ask · Write: allow\n</permissions>\n\n';
  const REMINDER = '<system-reminder>A sub-agent is still running.</system-reminder>';
  const parts = {
    memory: MEMORY,
    permissions: PERMISSIONS,
    beforeUser: renderTurnContextFrame(['Current date & time: Monday, 7 September 2026'], 'before-user'),
    text: 'find the regression',
    runningSubagents: REMINDER,
  };

  const parentStore = (): { store: BrainStore; wire: ReturnType<typeof composeTurnWire> } => {
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: 's-frames', userId: 7, model: 'anthropic/big' });
    const wire = composeTurnWire(parts);
    const { id } = projectUserTurn(store, 's-frames', parts.text);
    projectTurnWireFrames(store, 's-frames', id, wire.frames);
    store.appendMessage({
      id: 'a1', sessionId: 's-frames', parentId: null, role: 'assistant',
      content: { role: 'assistant', timestamp: 2_000, content: [{ type: 'text', text: 'looking' }] },
    });
    return { store, wire };
  };

  it('opens with the exact bytes the parent’s next request opens with', async () => {
    const { store, wire } = parentStore();
    const harness = await providerPayloadHarness();
    harness.session.messages.push(
      { role: 'user', content: [{ type: 'text', text: wire.prompt }] } as never,
      { role: 'assistant', content: [{ type: 'text', text: 'looking' }] } as never,
    );
    const payload = (await harness.prompt('and now this'))[0]!;
    const seeded = forkSeedMessages(storedContextMessages(store, 's-frames') as ForkMessage[], 9_000);
    const flatten = (content: unknown): string => (Array.isArray(content) ? content : [])
      .map((block) => (block as { text?: string }).text ?? '').join('');
    expect(seeded.map((message) => typeof message.content === 'string' ? message.content : flatten(message.content)))
      .toEqual(payload.messages.slice(0, seeded.length).map((message) => flatten(message.content)));
    expect(seeded[0]?.content).toContain(MEMORY);
    expect(seeded[0]?.content).toContain(PERMISSIONS);
    expect(seeded[0]?.content).toContain('placement="before-user"');
    expect(seeded[0]?.content).toContain(REMINDER);
  });

  it('keeps the transcript, the export and the curator on the person’s own words', () => {
    const { store } = parentStore();
    const rows = store.getMessages('s-frames').map((row) => ({ ...row, created_at: row.created_at }));
    const view = shapeBrainMessages(rows as never);
    expect(view.find((message) => message.role === 'user')?.text).toBe(parts.text);
    const exported = rehydrateWithTimestamps(store, 's-frames', process.cwd()).sm
      .buildSessionContext().messages as { role: string; content: unknown }[];
    expect(exported.find((message) => message.role === 'user')?.content).toBe(parts.text);
  });

  it('rehydrates to the request it sent, so a restart moves no cache', () => {
    const { store, wire } = parentStore();
    const replayed = (rehydrate(store, 's-frames', process.cwd()).buildSessionContext().messages as {
      role: string; content: unknown;
    }[]).find((message) => message.role === 'user');
    expect(replayed?.content).toBe(wire.prompt);
    // …and nothing of the bookkeeping itself reaches the replayed message.
    expect(Object.keys(replayed as object)).not.toContain('wireFrames');
  });
});

/** The other half of the same contract: the inherited transcript reaches the child intact (above), and the
 *  child's OWN request has to remain valid once that transcript is replayed into it.
 *
 *  A hosted-search result is server-owned content replayed byte for byte, but the tools block is not
 *  replayed with it — every session assembles its own, and a fork child's is narrowed by its delegated
 *  visibility policy and by whatever its account may still reach. When the replayed reference names a tool
 *  the child's request does not carry, Anthropic refuses the whole request with
 *  `Tool reference '<name>' not found in available tools`, and the child cannot take a single turn.
 *
 *  RED BEFORE THE FIX: restore copied `meta.content` into the payload unconditionally, so the second test
 *  below found the dangling reference still in the request (and `verifyAnthropicHostedReplay` then demanded
 *  it stay there). */
describe('a hosted-search reference replayed into a fork child', () => {
  const MODEL = 'claude-x';

  /** …and the tool block a fork child assembles has to be the parent's, or the repair above fires on
   *  content that should never have been at risk. Production fork `brain-ch-subagent-sub-dlg-292aee42`
   *  hit exactly that: its visibility policy withheld the six fork-denied schemas, so the child's block
   *  held 169 where its parent sent 175 AND a replayed reference naming `ShareImage` was dropped from the
   *  history on top of it — two divergences from one cause. */
  it('names a tool the child’s block still carries, because a fork advertises its parent’s', () => {
    const forked: DelegatedExecutionScope = { admin: false, projectIds: [1], owner: false, permissionBoundary: null, fork: true };
    // The production shape: the caller hands the EXECUTION policy's deny set down as `currentDenied`.
    const execution = delegatedToolPolicy(forked);
    const visible = visibleToolNames(
      ['Read', ...FORK_EXECUTE_DENIES],
      new Set(),
      delegatedVisibilityToolPolicy(forked, execution?.deny ?? []),
      undefined,
    );
    for (const name of FORK_EXECUTE_DENIES) expect(visible).toContain(name);
    const request = restoreAnthropicHostedReplay(
      { model: MODEL, tools: visible.map((name) => ({ name, input_schema: { type: 'object' } })), messages: [{ role: 'assistant', content: [{ type: 'text', text: 'shared' }] }] },
      [{ role: 'assistant', content: [{ type: 'text', text: 'shared' }], anthropicHostedToolReplay: { v: 1, content: SHARE_CONTENT } }],
      MODEL,
    );
    const block = (request as { messages: { content: Record<string, unknown>[] }[] }).messages[0]!
      .content.find((b) => b.type === 'tool_search_tool_result')!;
    expect((block.content as { tool_references: unknown[] }).tool_references)
      .toEqual([{ type: 'tool_reference', tool_name: 'ShareImage' }]);
  });

  const payload = (toolNames: readonly string[]): Record<string, unknown> => ({
    model: MODEL,
    tools: [
      { type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' },
      ...toolNames.map((name) => ({ name, input_schema: { type: 'object' }, defer_loading: true })),
    ],
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'searched' }] }],
  });

  const context = [{ role: 'assistant', content: [{ type: 'text', text: 'searched' }], anthropicHostedToolReplay: { v: 1, content: HOSTED_CONTENT } }];

  const referencesOf = (restored: unknown): unknown[] => {
    const message = (restored as { messages: { content: Record<string, unknown>[] }[] }).messages[0]!;
    const result = message.content.find((block) => block.type === 'tool_search_tool_result')!;
    return (result.content as { tool_references: unknown[] }).tool_references;
  };

  it('is replayed verbatim when the child’s request carries the tool', () => {
    const request = payload(['WorkflowStart', 'Read']);
    const restored = restoreAnthropicHostedReplay(request, context, MODEL);
    expect(referencesOf(restored)).toEqual([{ type: 'tool_reference', tool_name: 'WorkflowStart' }]);
    expect(verifyAnthropicHostedReplay(restored, context, MODEL)).toBe(true);
  });

  it('is dropped, and named, when the child’s request does not carry the tool', () => {
    const dropped: string[][] = [];
    const request = payload(['Read']);
    const restored = restoreAnthropicHostedReplay(request, context, MODEL, (names) => { dropped.push([...names]); });
    expect(referencesOf(restored)).toEqual([]);
    expect(dropped).toEqual([['WorkflowStart']]);
    // The result BLOCK itself must survive: Anthropic requires every server_tool_use to keep its pair.
    const content = (restored as { messages: { content: Record<string, unknown>[] }[] }).messages[0]!.content;
    expect(content.map((block) => block.type))
      .toEqual(['server_tool_use', 'tool_search_tool_result', 'text']);
    // …and the request that leaves must still pass the pre-flight check, or the repair would only move the
    // failure from the provider to the transport.
    expect(verifyAnthropicHostedReplay(restored, context, MODEL)).toBe(true);
  });
});
