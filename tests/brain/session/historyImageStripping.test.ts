import { describe, it, expect } from 'vitest';
import {
  HISTORY_IMAGE_PLACEHOLDER,
  collapseHistoricalImages,
  type PiAgentMessage,
} from '../../../src/brain/session/historyImageStripping.js';

const user = (text: string, timestamp = 1): PiAgentMessage => ({
  role: 'user', content: [{ type: 'text', text }], timestamp,
});

const assistantToolCall = (name: string): PiAgentMessage => ({
  role: 'assistant',
  content: [{ type: 'toolCall', id: 'call-1', name, arguments: {} }],
  api: 'anthropic-messages', provider: 'anthropic', model: 'test-model',
  usage: {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: 'toolUse', timestamp: 2,
});

type ToolResultContent = Extract<PiAgentMessage, { role: 'toolResult' }>['content'];
const toolResult = (
  toolName: string,
  content: ToolResultContent,
  timestamp = 3,
  toolCallId = 'call-1',
): PiAgentMessage => ({
  role: 'toolResult', toolCallId, toolName, content, isError: false, timestamp,
});

const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' } as const;
const placeholder = { type: 'text', text: HISTORY_IMAGE_PLACEHOLDER };

const contentOf = (message: PiAgentMessage): unknown => (message as { content: unknown }).content;

/** PI never downgrades images for vision-capable models, so every historical image is re-serialized into
 *  every provider call and the context grows monotonically. This pass is what stops that.
 *
 *  RED BEFORE THE CHANGE: the collapse ran on the egress COPY behind a per-index latch, so the live
 *  session — and therefore an export, a fork seed and every store-derived rebuild — still carried the
 *  image bytes the conversation had already stopped sending. */
describe('collapseHistoricalImages', () => {
  it('replaces image blocks in place, leaving text blocks untouched', () => {
    const messages: PiAgentMessage[] = [
      user('look at foo.png'),
      assistantToolCall('Read'),
      toolResult('Read', [{ type: 'text', text: 'Read image file [image/png]' }, image]),
    ];
    expect(collapseHistoricalImages(messages)).toBe(1);
    expect(contentOf(messages[2]!)).toEqual([{ type: 'text', text: 'Read image file [image/png]' }, placeholder]);
    expect(contentOf(messages[0]!)).toEqual([{ type: 'text', text: 'look at foo.png' }]);
  });

  it('collapses images from any source, in user messages too', () => {
    const messages: PiAgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'look' }, image], timestamp: 1 } as PiAgentMessage,
      toolResult('Screenshot', [image, { type: 'text', text: 'shot' }]),
    ];
    expect(collapseHistoricalImages(messages)).toBe(2);
    expect(contentOf(messages[0]!)).toEqual([{ type: 'text', text: 'look' }, placeholder]);
    expect(contentOf(messages[1]!)).toEqual([placeholder, { type: 'text', text: 'shot' }]);
  });

  it('collapses a run of consecutive images into ONE placeholder', () => {
    const messages: PiAgentMessage[] = [toolResult('Read', [image, image, image])];
    collapseHistoricalImages(messages);
    expect(contentOf(messages[0]!)).toEqual([placeholder]);
  });

  it('is idempotent: a second pass changes nothing', () => {
    const messages: PiAgentMessage[] = [toolResult('Read', [image, { type: 'text', text: 'x' }])];
    expect(collapseHistoricalImages(messages)).toBe(1);
    const after = contentOf(messages[0]!);
    expect(collapseHistoricalImages(messages)).toBe(0);
    expect(contentOf(messages[0]!)).toEqual(after);
  });

  it('reports nothing changed for a history with no images at all', () => {
    const messages: PiAgentMessage[] = [user('one'), assistantToolCall('Read'), toolResult('Read', [{ type: 'text', text: 'plain' }])];
    expect(collapseHistoricalImages(messages)).toBe(0);
  });

  it('leaves an assistant message alone — its content cannot carry an image block', () => {
    const messages: PiAgentMessage[] = [assistantToolCall('Read')];
    const before = contentOf(messages[0]!);
    expect(collapseHistoricalImages(messages)).toBe(0);
    expect(contentOf(messages[0]!)).toBe(before);
  });
});
