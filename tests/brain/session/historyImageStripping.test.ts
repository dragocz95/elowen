import { describe, it, expect } from 'vitest';
import {
  HISTORY_IMAGE_PLACEHOLDER,
  installHistoryImageStripping,
  stripHistoricalImages,
  type PiAgentMessage,
} from '../../../src/brain/session/historyImageStripping.js';

const user = (text: string): PiAgentMessage => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 });

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
const toolResult = (toolName: string, content: ToolResultContent): PiAgentMessage => ({
  role: 'toolResult', toolCallId: 'call-1', toolName, content, isError: false, timestamp: 3,
});

const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' } as const;
const placeholder = { type: 'text', text: HISTORY_IMAGE_PLACEHOLDER };

describe('stripHistoricalImages', () => {
  it('replaces image blocks before the last user message, leaving text blocks untouched', () => {
    const messages: PiAgentMessage[] = [
      user('look at foo.png'),
      assistantToolCall('Read'),
      toolResult('Read', [{ type: 'text', text: 'Read image file [image/png]' }, image]),
      user('next'),
    ];
    const result = stripHistoricalImages(messages);
    expect(result[2]).toEqual({
      ...messages[2],
      content: [{ type: 'text', text: 'Read image file [image/png]' }, placeholder],
    });
    expect(result[0]).toBe(messages[0]);
    expect(result[1]).toBe(messages[1]);
    expect(result[3]).toBe(messages[3]);
  });

  it('keeps the real image for the current run (tool result after the last user message)', () => {
    // Turn 1's context: the freshly-read image follows the last user message → the model still sees it.
    const turn1: PiAgentMessage[] = [
      user('look at foo.png'),
      assistantToolCall('Read'),
      toolResult('Read', [{ type: 'text', text: 'Read image file [image/png]' }, image]),
    ];
    expect(stripHistoricalImages(turn1)).toBe(turn1);
    // The SAME tool result becomes a placeholder once a newer user turn exists (turn 3's context).
    const turn3 = stripHistoricalImages([...turn1, user('next')]);
    expect(turn3[2]).toEqual({ ...turn1[2], content: [{ type: 'text', text: 'Read image file [image/png]' }, placeholder] });
  });

  it('strips historical images from ANY source — a tool unknown to any shipped plugin', () => {
    // The global net: nothing here is MCP- or files-specific; a future plugin's image lands in a
    // toolResult content array exactly like this and is stripped the same way.
    const messages: PiAgentMessage[] = [
      user('run the gadget'),
      assistantToolCall('SomeFuturePluginTool'),
      toolResult('SomeFuturePluginTool', [{ type: 'image', data: 'BBBB', mimeType: 'image/webp' }]),
      user('and now?'),
    ];
    const result = stripHistoricalImages(messages);
    expect(result[2]).toEqual({ ...messages[2], content: [placeholder] });
  });

  it('strips images from historical user messages and collapses consecutive placeholders', () => {
    const messages: PiAgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'two shots' }, image, image], timestamp: 1 },
      user('next'),
    ];
    const result = stripHistoricalImages(messages);
    expect(result[0]).toEqual({ ...messages[0], content: [{ type: 'text', text: 'two shots' }, placeholder] });
  });

  it('is idempotent and does not mutate its input', () => {
    const original: PiAgentMessage[] = [
      user('look'),
      assistantToolCall('Read'),
      toolResult('Read', [image]),
      user('next'),
    ];
    const snapshot = structuredClone(original);
    const once = stripHistoricalImages(original);
    expect(original).toEqual(snapshot); // inputs untouched
    const twice = stripHistoricalImages(once);
    expect(twice).toBe(once); // second pass is a no-op returning the same reference
  });

  it('returns the input array unchanged when nothing needs stripping', () => {
    const messages: PiAgentMessage[] = [user('hello'), user('again')];
    expect(stripHistoricalImages(messages)).toBe(messages);
  });
});

describe('installHistoryImageStripping', () => {
  it('composes with a pre-existing transformContext: previous hook runs first, then stripping', async () => {
    const calls: string[] = [];
    const injected = user('injected-by-previous-hook');
    const session = {
      agent: {
        transformContext: async (messages: PiAgentMessage[]): Promise<PiAgentMessage[]> => {
          calls.push('previous');
          return [...messages, injected];
        },
      },
    };
    installHistoryImageStripping(session);
    const input: PiAgentMessage[] = [user('look'), toolResult('Read', [image])];
    const result = await session.agent.transformContext(input);
    expect(calls).toEqual(['previous']);
    // The previous hook's appended user message is present (not clobbered) AND makes the tool result
    // historical, so its image is stripped from the composed output.
    expect(result[2]).toBe(injected);
    expect(result[1]).toEqual({ ...input[1], content: [placeholder] });
  });

  it('works when no previous transformContext exists', async () => {
    const session: { agent: { transformContext?: (m: PiAgentMessage[], s?: AbortSignal) => Promise<PiAgentMessage[]> } } = { agent: {} };
    installHistoryImageStripping(session);
    const input: PiAgentMessage[] = [user('look'), toolResult('Read', [image]), user('next')];
    const result = await session.agent.transformContext!(input);
    expect(result[1]).toEqual({ ...input[1], content: [placeholder] });
  });
});
