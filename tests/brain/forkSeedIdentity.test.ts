import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { rehydrate, storedContextMessages } from '../../src/brain/persistence.js';
import { forkSeedMessages, type ForkMessage } from '../../src/brain/session/forkPrefix.js';
import { HISTORY_IMAGE_PLACEHOLDER } from '../../src/brain/session/historyImageStripping.js';
import { createToolSearchHandle, seedActivatedFromHistory } from '../../src/brain/toolSearch/toolSearchTool.js';

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
    store.recordClearedToolResult('s-parent', {
      toolCallId: 'call-bash', occurredAt: 2_200, mode: 'preview', bytes: 50_007,
      preview: OUTPUT.slice(0, 20), path: '/data/tool-results/s-parent/call-bash.v1-preview-50007.txt',
      placeholder: PLACEHOLDER,
    });
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

  it('drops a tool result whose call the compaction cut, which the raw rows would hand to the provider', () => {
    append('toolResult', {
      role: 'toolResult', toolCallId: 'call-gone', toolName: 'Read', isError: false,
      timestamp: 3_000, content: [{ type: 'text', text: 'orphan' }],
    });
    expect(seed().some((message) => message.toolCallId === 'call-gone')).toBe(false);
    expect(store.getMessages('s-parent').some((r) => r.content.includes('call-gone'))).toBe(true);
  });
});
