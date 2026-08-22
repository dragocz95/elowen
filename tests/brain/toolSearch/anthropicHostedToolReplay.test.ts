import { describe, expect, it, vi } from 'vitest';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { AgentSession, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  anthropicHostedReplayMetadata,
  captureAnthropicHostedReplay,
  createAnthropicHostedToolReplay,
  restoreAnthropicHostedReplay,
  verifyAnthropicHostedReplay,
  type AnthropicHostedReplayMetadata,
} from '../../../src/brain/session/anthropicHostedToolReplay.js';

const SIGNATURE_A = 'signed-thinking-a';
const SIGNATURE_B = 'signed-thinking-b';
const MODEL = { id: 'claude-opus-5', provider: 'anthropic', api: 'anthropic-messages' } as const;

const rawContent = () => [
  { type: 'text', text: 'Searching.' },
  { type: 'thinking', thinking: 'first', signature: SIGNATURE_A },
  { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_bm25', input: { query: 'Elowen docs' } },
  { type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'tool_search_tool_search_result', tool_references: [{ type: 'tool_reference', tool_name: 'DocsSearch' }] } },
  { type: 'thinking', thinking: 'second', signature: SIGNATURE_B },
  { type: 'tool_use', id: 'toolu_docs', name: 'DocsSearch', input: { query: 'slash commands' } },
];

const event = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const block = (index: number, content_block: Record<string, unknown>, deltas: Record<string, unknown>[] = []) => [
  event('content_block_start', { type: 'content_block_start', index, content_block }),
  ...deltas.map((delta) => event('content_block_delta', { type: 'content_block_delta', index, delta })),
  event('content_block_stop', { type: 'content_block_stop', index }),
].join('');

const sse = [
  block(0, { type: 'text', text: 'Searching.' }),
  block(1, { type: 'thinking', thinking: 'first', signature: SIGNATURE_A }),
  block(2, { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_bm25', input: {} }, [
    { type: 'input_json_delta', partial_json: '{"query":"Elowen docs"}' },
  ]),
  block(3, rawContent()[3]!),
  block(4, { type: 'thinking', thinking: 'second', signature: SIGNATURE_B }),
  block(5, { type: 'tool_use', id: 'toolu_docs', name: 'DocsSearch', input: { query: 'slash commands' } }),
  event('message_stop', { type: 'message_stop' }),
].join('');

const metadata = (): AnthropicHostedReplayMetadata => ({ v: 1, content: rawContent() });

const assistant = (meta: AnthropicHostedReplayMetadata | null = metadata()) => ({
  role: 'assistant',
  content: [
    { type: 'text', text: 'Searching.' },
    { type: 'thinking', thinking: 'first', thinkingSignature: SIGNATURE_A },
    { type: 'thinking', thinking: 'second', thinkingSignature: SIGNATURE_B },
    { type: 'toolCall', id: 'toolu_docs', name: 'DocsSearch', arguments: { query: 'slash commands' } },
  ],
  api: 'anthropic-messages', provider: 'anthropic', model: 'claude-opus-5',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: 'toolUse', timestamp: 1,
  ...(meta ? { anthropicHostedToolReplay: meta } : {}),
});

const wireAssistant = () => ({
  role: 'assistant',
  content: [
    { type: 'text', text: 'Searching.' },
    { type: 'thinking', thinking: 'first', signature: SIGNATURE_A },
    { type: 'thinking', thinking: 'second', signature: SIGNATURE_B },
    { type: 'tool_use', id: 'toolu_docs', name: 'mcp__DocsSearch', input: { query: 'slash commands' } },
  ],
});

function fakeSession(responseSse: string, requestMessages: unknown[] = []) {
  const final = assistant(null);
  const native = vi.fn((_model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      try {
        const response = await options.fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', body: JSON.stringify({ model: 'claude-opus-5', messages: requestMessages }),
        });
        await response.text();
        stream.push({ type: 'done', reason: 'toolUse', message: final as never });
      } catch (error) {
        stream.push({
          type: 'error', reason: 'error',
          error: { ...final, content: [], stopReason: 'error', errorMessage: error instanceof Error ? error.message : String(error) } as never,
        });
      }
      stream.end();
    })();
    return stream;
  });
  const agent = { streamFunction: native };
  const replay = createAnthropicHostedToolReplay(MODEL as never);
  replay.install({ agent } as unknown as AgentSession);
  return {
    agent,
    final,
    fetch: vi.fn(async () => new Response(responseSse, { status: 200, headers: { 'content-type': 'text/event-stream' } })),
  };
}

describe('Anthropic hosted tool-search replay', () => {
  it('captures the complete raw assistant content and validates the server search pair', () => {
    expect(captureAnthropicHostedReplay(sse)).toEqual(metadata());
  });

  it('gives up on a capture it cannot trust instead of failing the response', () => {
    // These used to throw, which killed the live turn: an unpaired search call reached production and cost
    // the user a finished answer. Capturing is an optimisation, and "no metadata" is the same safe outcome
    // as a response that never used hosted search — nothing malformed is replayed either way.
    const incomplete = sse.replace(block(3, rawContent()[3]!), '');
    expect(captureAnthropicHostedReplay(incomplete)).toBeUndefined();
    const unknownDelta = sse.replace(
      block(0, { type: 'text', text: 'Searching.' }),
      block(0, { type: 'text', text: 'Searching.' }, [{ type: 'citations_delta', citation: {} }]),
    );
    expect(captureAnthropicHostedReplay(unknownDelta)).toBeUndefined();
    // A stream cut mid-frame: the tail is not parseable JSON, which is how the production crash surfaced.
    expect(captureAnthropicHostedReplay(`${sse.slice(0, sse.length - 40)}`)).toBeUndefined();
  });

  it('restores the assistant turn verbatim without mutating signed thinking or the input payload', () => {
    const payload = {
      model: 'claude-opus-5',
      messages: [wireAssistant(), { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_docs', content: 'result' }] }],
      tools: [],
    };
    const before = structuredClone(payload);
    const restored = restoreAnthropicHostedReplay(payload, [assistant()], 'claude-opus-5') as typeof payload;

    expect(payload).toEqual(before);
    expect(restored.messages[0]?.content).toEqual(rawContent());
    expect(restored.messages[0]?.content[1]).toEqual(before.messages[0]?.content[1]);
    expect(restored.messages[0]?.content[4]).toEqual(before.messages[0]?.content[2]);
    expect(verifyAnthropicHostedReplay(payload, [assistant()], 'claude-opus-5')).toBe(false);
    expect(verifyAnthropicHostedReplay(restored, [assistant()], 'claude-opus-5')).toBe(true);
  });

  it('matches PI filtering of empty text and invalid Unicode instead of silently missing the turn', () => {
    const raw = metadata();
    const brokenText = `Search${String.fromCharCode(0xD800)}ing.`;
    raw.content.splice(1, 0, { type: 'text', text: '   ' });
    raw.content[0] = { type: 'text', text: brokenText };
    const stored = assistant(raw);
    stored.content[0] = { type: 'text', text: brokenText };
    const payload = { model: 'claude-opus-5', messages: [wireAssistant()], tools: [] };
    (payload.messages[0]!.content[0] as { text: string }).text = 'Searching.';
    expect((restoreAnthropicHostedReplay(payload, [stored], 'claude-opus-5') as typeof payload).messages[0]?.content).toEqual(raw.content);
  });

  it('survives persistence and stays fail-closed for another model or missing metadata', () => {
    const persisted = JSON.parse(JSON.stringify(assistant()));
    expect(anthropicHostedReplayMetadata(persisted)).toEqual(metadata());
    expect(restoreAnthropicHostedReplay({ model: 'claude-opus-4-8', messages: [wireAssistant()] }, [persisted], 'claude-opus-5')).toBeUndefined();
    expect(restoreAnthropicHostedReplay({ model: 'claude-opus-5', messages: [wireAssistant()] }, [assistant(null)], 'claude-opus-5')).toBeUndefined();
  });

  it('captures raw SSE through one streaming body and attaches replay metadata before done', async () => {
    const fixture = fakeSession(sse);
    const events = [];
    const stream = fixture.agent.streamFunction(
      { id: 'claude-opus-5', provider: 'anthropic', api: 'anthropic-messages' } as never,
      { messages: [], tools: [] } as never,
      { fetch: fixture.fetch } as never,
    );
    for await (const current of stream) events.push(current);

    const done = events.find((current) => current.type === 'done');
    expect(done?.type === 'done' ? anthropicHostedReplayMetadata(done.message) : undefined).toEqual(metadata());
    expect((done?.type === 'done' ? done.message.content : [])).toEqual(fixture.final.content);
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
  });

  it('delivers the answer when the capture fails, instead of killing the response', async () => {
    // REGRESSION (production, 22 Aug 2026): this asserted the opposite — a failed capture had to surface as
    // an error event. It did, by calling controller.error() on the stream carrying the model's reply, so a
    // turn on claude-opus-5 died mid-run and the user had to start the agent again. The tap is a passive
    // observer of someone else's stream; only a broken PROVIDER stream may take that stream down.
    const fixture = fakeSession(sse.replace(block(3, rawContent()[3]!), ''));
    const events = [];
    const stream = fixture.agent.streamFunction(
      { id: 'claude-opus-5', provider: 'anthropic', api: 'anthropic-messages' } as never,
      { messages: [], tools: [] } as never,
      { fetch: fixture.fetch } as never,
    );
    for await (const current of stream) events.push(current);

    const done = events.find((current) => current.type === 'done');
    expect(done).toBeDefined();
    expect(events.some((current) => current.type === 'error')).toBe(false);
    // The answer survives; only the replay metadata is missing, which is what an unpaired capture means.
    expect(done?.type === 'done' ? done.message.content : []).toEqual(fixture.final.content);
    expect(done?.type === 'done' ? anthropicHostedReplayMetadata(done.message) : 'unset').toBeUndefined();
  });

  it.each(['provider SSE error', 'request abort'])('cancels a pending capture on %s instead of hanging the terminal error', async (reason) => {
    const cancelled = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(event('error', { type: 'error', error: { message: reason } })));
      },
      cancel: cancelled,
    });
    const final = assistant(null);
    const native = vi.fn((_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const response = await options.fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
        });
        const reader = response.body!.getReader();
        await reader.read();
        reader.releaseLock();
        stream.push({
          type: 'error', reason: reason === 'request abort' ? 'aborted' : 'error',
          error: { ...final, content: [], stopReason: reason === 'request abort' ? 'aborted' : 'error', errorMessage: reason } as never,
        });
        stream.end();
      })();
      return stream;
    });
    const agent = { streamFunction: native };
    const replay = createAnthropicHostedToolReplay(MODEL as never);
    replay.install({ agent } as unknown as AgentSession);
    const stream = agent.streamFunction(
      { id: 'claude-opus-5', provider: 'anthropic', api: 'anthropic-messages' } as never,
      { messages: [], tools: [] } as never,
      { fetch: vi.fn(async () => new Response(source, { status: 200, headers: { 'content-type': 'text/event-stream' } })) } as never,
    );
    const events = [];
    for await (const current of stream) events.push(current);

    expect(events.at(-1)?.type).toBe('error');
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('blocks the network when extensions failed to restore a persisted hosted turn', async () => {
    const fixture = fakeSession(sse, [wireAssistant()]);
    const events = [];
    const stream = fixture.agent.streamFunction(
      { id: 'claude-opus-5', provider: 'anthropic', api: 'anthropic-messages' } as never,
      { messages: [assistant()], tools: [] } as never,
      { fetch: fixture.fetch } as never,
    );
    for await (const current of stream) events.push(current);

    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe('error');
    expect(events.at(-1)?.type === 'error' ? events.at(-1)?.error.errorMessage : '').toContain('missing persisted hosted-search');
  });

  it('registers restoration before provider request', () => {
    const handlers = new Map<string, (event: { payload: unknown }) => unknown>();
    const replay = createAnthropicHostedToolReplay(MODEL as never);
    replay.extension({ on: vi.fn((name: string, handler: (event: { payload: unknown }) => unknown) => handlers.set(name, handler)) } as unknown as ExtensionAPI);
    expect([...handlers.keys()]).toEqual(['before_provider_request']);
  });
});
