import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { toBrainEvent } from '../../src/brain/events.js';
import { externalizeImageBlocks } from '../../src/brain/chatImages.js';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { shapeBrainMessages } from '../../src/brain/messageView.js';

// Reading an image file handed the PICTURE to the model and the words "Read image file" to the person
// asking. These pin the whole path that closes that gap: the live event names a stored file, the file is
// the same one persistence writes for the same bytes, and a reload rebuilds the identical picture — while
// a text read, a failed read and every other tool stay exactly as they were.

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const BASE64 = PNG.toString('base64');
/** What `plugins/files`' Read returns for an image: the model-facing note plus the bytes. */
const readImageResult = () => ({
  content: [{ type: 'text', text: 'Read image file [image/png]' }, { type: 'image', data: BASE64, mimeType: 'image/png' }],
  details: { ok: true, tool: 'Read', image: true, mimeType: 'image/png' },
});
const readTextResult = () => ({
  content: [{ type: 'text', text: '     1\tconst a = 1;' }],
  details: { ok: true, tool: 'Read', truncated: false },
});

const end = (over: Record<string, unknown>, dir?: string) => toBrainEvent({
  type: 'tool_execution_end', toolCallId: 'r1', toolName: 'Read', result: readImageResult(), ...over,
} as unknown as AgentSessionEvent, 1_000, dir);

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'read-preview-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the live event a Read of an image produces', () => {
  it('puts the picture in front of the user as an ordinary chat image', () => {
    const event = end({}, dir);

    expect(event).toEqual({ type: 'image', ref: expect.stringMatching(/^\/api\/brain\/chat-images\/[0-9a-f]{64}\.png$/), id: 'r1' });
  });

  it('has really written the bytes, so the ref the client is handed resolves', () => {
    const ref = (end({}, dir) as { ref: string }).ref;
    const file = ref.slice(ref.lastIndexOf('/') + 1);

    expect(existsSync(join(dir, file))).toBe(true);
    expect(readFileSync(join(dir, file))).toEqual(PNG);
  });

  it('names the very file persistence writes for the same result, so both mean one picture', () => {
    // Content addressing is the whole dedupe contract: the live preview and the row written moments later
    // at message_end must not become two copies of one image under two names.
    const ref = (end({}, dir) as { ref: string }).ref;
    const persisted = externalizeImageBlocks({ role: 'toolResult', ...readImageResult() }, dir) as {
      content: { type: string; ref?: { file: string } }[];
    };

    expect(ref).toBe(`/api/brain/chat-images/${persisted.content[1]!.ref!.file}`);
  });

  it('leaves a TEXT read alone — there is no picture to show', () => {
    const event = end({ result: readTextResult() }, dir);

    expect(event?.type).not.toBe('image');
  });

  it('leaves a FAILED read alone, so its refusal stays readable instead of becoming a thumbnail', () => {
    const event = end({ isError: true }, dir);

    expect(event?.type).not.toBe('image');
  });

  it('does not preview an image any OTHER tool returned', () => {
    // Debugging a page means a screenshot every few seconds; forwarding each one automatically is exactly
    // what ShareImage exists to avoid.
    const event = end({ toolName: 'take_screenshot' }, dir);

    expect(event?.type).not.toBe('image');
  });

  it('shows nothing rather than a dead link when the session has nowhere to store images', () => {
    const event = end({});

    expect(event?.type).not.toBe('image');
  });
});

describe('the same Read after a reload', () => {
  let store: BrainStore;
  beforeEach(() => {
    store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: 'brain-1', userId: 1, model: 'm' });
  });

  /** The transcript as it is durably stored: the assistant's call plus the externalized tool result. */
  const rows = (extra: { call: unknown; result: unknown }[] = []) => {
    const calls = [{ type: 'toolCall', id: 'r1', name: 'Read', arguments: { file_path: '/repo/logo.png' } },
      ...extra.map((e) => e.call)];
    store.appendMessage({ id: 'm1', sessionId: 'brain-1', parentId: null, role: 'assistant', content: { role: 'assistant', content: calls } });
    store.appendMessage({
      id: 'm2', sessionId: 'brain-1', parentId: null, role: 'toolResult',
      content: externalizeImageBlocks({ role: 'toolResult', toolCallId: 'r1', ...readImageResult() }, dir),
    });
    extra.forEach((e, i) => store.appendMessage({ id: `m${i + 3}`, sessionId: 'brain-1', parentId: null, role: 'toolResult', content: e.result }));
    return store.getMessages('brain-1');
  };

  const sharedFile = () => {
    const persisted = externalizeImageBlocks({ role: 'toolResult', ...readImageResult() }, dir) as {
      content: { ref?: { file: string } }[];
    };
    return persisted.content[1]!.ref!.file;
  };

  it('rebuilds the picture under its own tool row', () => {
    const [view] = shapeBrainMessages(rows());

    expect(view!.segments?.map((s) => s.kind)).toEqual(['tool', 'image']);
    expect(view!.segments?.at(-1)).toEqual({
      kind: 'image', image: { url: `/brain/chat-images/${sharedFile()}`, mimeType: 'image/png' },
    });
  });

  it('rebuilds nothing extra for a text read', () => {
    store.appendMessage({
      id: 'm1', sessionId: 'brain-1', parentId: null, role: 'assistant',
      content: { role: 'assistant', content: [{ type: 'toolCall', id: 'r1', name: 'Read', arguments: { file_path: '/repo/a.ts' } }] },
    });
    store.appendMessage({
      id: 'm2', sessionId: 'brain-1', parentId: null, role: 'toolResult',
      content: { role: 'toolResult', toolCallId: 'r1', ...readTextResult() },
    });

    const [view] = shapeBrainMessages(store.getMessages('brain-1'));

    expect(view!.segments?.some((s) => s.kind === 'image')).toBe(false);
  });

  it('shows one picture, not two, when the agent then shares that very file', () => {
    // ShareImage(latest: true) re-shares the file the read already put on screen. Deduped on the stored
    // name — which IS the bytes' sha256 — never on the file name the model happened to read.
    const file = sharedFile();
    const views = shapeBrainMessages(rows([{
      call: { type: 'toolCall', id: 's1', name: 'ShareImage', arguments: { latest: true } },
      result: {
        role: 'toolResult', toolCallId: 's1', toolName: 'ShareImage', isError: false,
        content: [{ type: 'text', text: 'Shared the image with the user.' }],
        details: { sharedImage: { file, mimeType: 'image/png' } },
      },
    }]));

    const images = views.flatMap((v) => v.segments ?? []).filter((s) => s.kind === 'image');
    expect(images).toHaveLength(1);
    // The share still leaves a readable row behind; it just does not repeat the picture.
    expect(views.flatMap((v) => v.segments ?? []).filter((s) => s.kind === 'tool')).toHaveLength(2);
  });

  it('still shows a DIFFERENT image the agent shares in the same turn', () => {
    const other = 'b'.repeat(64) + '.png';
    const views = shapeBrainMessages(rows([{
      call: { type: 'toolCall', id: 's1', name: 'ShareImage', arguments: {} },
      result: {
        role: 'toolResult', toolCallId: 's1', toolName: 'ShareImage', isError: false,
        content: [{ type: 'text', text: 'Shared the image with the user.' }],
        details: { sharedImage: { file: other, mimeType: 'image/png' } },
      },
    }]));

    expect(views.flatMap((v) => v.segments ?? []).filter((s) => s.kind === 'image')).toHaveLength(2);
  });
});
