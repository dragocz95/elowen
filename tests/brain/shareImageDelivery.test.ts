import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { shapeBrainMessages } from '../../src/brain/messageView.js';
import { toBrainEvent } from '../../src/brain/events.js';
import { TranscriptModel } from '../../src/brain/transcriptModel.js';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';

// The delivery half: what ShareImage records on the row is only useful if the surfaces actually rebuild a
// picture from it. Both ends used to be tested against hand-written fixtures and never against each
// other, so the server could have returned anything and stayed green.

const FILE = 'a'.repeat(64) + '.png';
const shareResult = (over: Record<string, unknown> = {}) => ({
  role: 'toolResult', toolCallId: 'c1', toolName: 'ShareImage', isError: false,
  content: [{ type: 'text', text: 'Shared the image with the user.' }],
  details: { sharedImage: { file: FILE, mimeType: 'image/png' } },
  ...over,
});
const assistantSharing = { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'ShareImage', arguments: {} }] };

let db: ReturnType<typeof openDb>;
let store: BrainStore;

beforeEach(() => {
  db = openDb(':memory:');
  store = new BrainStore(db);
  store.createSession({ id: 'brain-1', userId: 1, model: 'm' });
});

const rows = (result: unknown) => {
  store.appendMessage({ id: 'm1', sessionId: 'brain-1', parentId: null, role: 'assistant', content: assistantSharing });
  store.appendMessage({ id: 'm2', sessionId: 'brain-1', parentId: null, role: 'toolResult', content: result });
  return store.getMessages('brain-1');
};

describe('a shared image after a reload', () => {
  it('comes back as an image segment pointing at the stored file', () => {
    const [view] = shapeBrainMessages(rows(shareResult()));

    expect(view!.segments).toEqual([{ kind: 'image', image: { url: `/brain/chat-images/${FILE}`, mimeType: 'image/png' } }]);
  });

  it('carries the caption the agent wrote', () => {
    const [view] = shapeBrainMessages(rows(shareResult({ details: { sharedImage: { file: FILE, mimeType: 'image/png', caption: 'the broken header' } } })));

    expect(view!.segments).toContainEqual(expect.objectContaining({ kind: 'image', caption: 'the broken header' }));
  });

  it('shows a FAILED share as an ordinary tool row, not as a picture', () => {
    // A refusal ("outside your accessible repositories") has to stay readable — rendering it as an image
    // would leave the user with a broken thumbnail and no idea why nothing was shared.
    const [view] = shapeBrainMessages(rows({ ...shareResult(), isError: true, details: {} }));

    expect(view!.segments?.some((s) => s.kind === 'image')).toBe(false);
    expect(view!.segments?.some((s) => s.kind === 'tool')).toBe(true);
  });
});

describe('a shared file after a reload and while live', () => {
  const file = `${'b'.repeat(64)}.bin`;
  const stored = { file, name: 'jednatele-chetty-webhouse.htm', size: 42 };

  it('rebuilds the stored result as a download segment', () => {
    store.appendMessage({ id: 'f1', sessionId: 'brain-1', parentId: null, role: 'assistant', content: { role: 'assistant', content: [{ type: 'toolCall', id: 'fc1', name: 'ShareFile', arguments: {} }] } });
    store.appendMessage({ id: 'f2', sessionId: 'brain-1', parentId: null, role: 'toolResult', content: {
      role: 'toolResult', toolCallId: 'fc1', toolName: 'ShareFile', isError: false,
      content: [{ type: 'text', text: 'Shared the file.' }], details: { sharedFile: { ...stored, caption: 'ke stažení' } },
    } });

    const [view] = shapeBrainMessages(store.getMessages('brain-1'));
    expect(view!.segments).toEqual([{ kind: 'file', file: { url: `/brain/chat-files/${file}`, name: stored.name, size: 42 }, caption: 'ke stažení' }]);
  });

  it('announces the live download with the same metadata', () => {
    const event = toBrainEvent({
      type: 'tool_execution_end', toolName: 'ShareFile', args: {},
      result: { content: [{ type: 'text', text: 'Shared the file.' }], details: { sharedFile: stored } },
    } as unknown as AgentSessionEvent);

    expect(event).toMatchObject({ type: 'file', ref: `/api/brain/chat-files/${file}`, name: stored.name, size: 42 });
  });
});

describe('a shared image while the turn is live', () => {
  const endEvent = (details: unknown) => toBrainEvent({
    type: 'tool_execution_end', toolName: 'ShareImage', args: {},
    result: { content: [{ type: 'text', text: 'Shared the image with the user.' }], details },
  } as unknown as AgentSessionEvent);

  it('is announced as an image event the clients can load', () => {
    expect(endEvent({ sharedImage: { file: FILE, mimeType: 'image/png', caption: 'this one' } }))
      .toMatchObject({ type: 'image', ref: `/api/brain/chat-images/${FILE}`, caption: 'this one' });
  });

  it('stays a tool event when the share failed', () => {
    expect(endEvent({})?.type).not.toBe('image');
  });

  /** What the terminal would actually print for the one turn the model built. */
  const rendered = (event: unknown): string => {
    const model = new TranscriptModel();
    const applied = model.apply(event as never);
    expect(applied).toBe(true); // false means the event fell through to `default` and vanished
    const turn = model.turnAt(0);
    return turn?.role === 'elowen' ? turn.segments.map((s) => (s.kind === 'text' ? s.text : '')).join('') : '';
  };

  it('reaches the terminal as a line, since a terminal draws no pictures', () => {
    // Dropping it would be worse than terse: the agent says "here it is" and the user sees nothing.
    const text = rendered({ type: 'image', ref: `/api/brain/chat-images/${FILE}`, caption: 'the broken header' });

    expect(text).toContain('🖼');
    expect(text).toContain('the broken header');
  });

  it('names the file in the terminal when there is no caption', () => {
    expect(rendered({ type: 'image', ref: `/api/brain/chat-images/${FILE}` })).toContain(FILE);
  });
});

afterEach(() => {
  const tmp = mkdtempSync(join(tmpdir(), 'noop-'));
  rmSync(tmp, { recursive: true, force: true });
});
