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

const unpairedContent = () => rawContent().filter((block) => block.type !== 'tool_search_tool_result');
const unpairedSse = [
  block(0, { type: 'text', text: 'Searching.' }),
  block(1, { type: 'thinking', thinking: 'first', signature: SIGNATURE_A }),
  block(2, { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_bm25', input: {} }, [
    { type: 'input_json_delta', partial_json: '{"query":"Elowen docs"}' },
  ]),
  block(3, { type: 'thinking', thinking: 'second', signature: SIGNATURE_B }),
  block(4, { type: 'tool_use', id: 'toolu_docs', name: 'DocsSearch', input: { query: 'slash commands' } }),
  event('message_stop', { type: 'message_stop' }),
].join('');
const mismatchedSse = sse.replace('"tool_use_id":"srvtoolu_1"', '"tool_use_id":"srvtoolu_unmatched"');

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
  const handlers = new Map<string, (event: any) => unknown>();
  const listeners: ((event: any) => void)[] = [];
  const replay = createAnthropicHostedToolReplay(MODEL as never);
  replay.extension({ on: vi.fn((name: string, handler: (event: any) => unknown) => handlers.set(name, handler)) } as unknown as ExtensionAPI);
  replay.install({ agent, subscribe: (listener: (event: any) => void) => { listeners.push(listener); return () => {}; } } as unknown as AgentSession);
  return {
    agent,
    final,
    handlers,
    emit: (event: any) => { for (const listener of listeners) listener(event); },
    fetch: vi.fn(async () => new Response(responseSse, { status: 200, headers: { 'content-type': 'text/event-stream' } })),
  };
}

describe('Anthropic hosted tool-search replay', () => {
  it('captures complete hosted topology as provider-authoritative raw content', () => {
    const captured = captureAnthropicHostedReplay(sse);
    expect(captured).toEqual(metadata());
    expect(JSON.stringify(JSON.parse(JSON.stringify(captured))?.content)).toBe(JSON.stringify(rawContent()));
  });

  it('never persists a hosted call without its exact result and ignores already-poisoned metadata', () => {
    expect(captureAnthropicHostedReplay(unpairedSse)).toBeUndefined();
    expect(captureAnthropicHostedReplay(mismatchedSse)).toBeUndefined();

    const poisoned = assistant({ v: 1, content: unpairedContent() });
    const payload = { model: 'claude-opus-5', messages: [wireAssistant()], tools: [] };
    expect(anthropicHostedReplayMetadata(poisoned as never)).toBeUndefined();
    expect(restoreAnthropicHostedReplay(payload, [poisoned], 'claude-opus-5')).toBeUndefined();
    expect(verifyAnthropicHostedReplay(payload, [poisoned], 'claude-opus-5')).toBe(true);
  });

  it('preserves citations deltas in complete hosted responses', () => {
    const citation = {
      type: 'web_search_result_location', url: 'https://example.test', title: 'Example',
      encrypted_index: 'idx', cited_text: 'Searching.',
    };
    const withCitation = sse.replace(
      block(0, { type: 'text', text: 'Searching.' }),
      block(0, { type: 'text', text: 'Searching.', citations: null }, [
        { type: 'citations_delta', citation },
      ]),
    );
    const expected = rawContent();
    expected[0] = { type: 'text', text: 'Searching.', citations: [citation] };
    expect(captureAnthropicHostedReplay(withCitation)?.content).toEqual(expected);
  });

  it('refuses syntactically incomplete or malformed SSE captures', () => {
    const malformedJson = sse.replace(
      event('message_stop', { type: 'message_stop' }),
      'event: message_stop\ndata: {"type":"message_stop"\n\n',
    );
    const missingIndex = sse.replace(
      event('content_block_stop', { type: 'content_block_stop', index: 2 }),
      event('content_block_stop', { type: 'content_block_stop' }),
    );
    const duplicateIndex = sse.replace(
      block(3, rawContent()[3]!),
      block(2, rawContent()[3]!),
    );
    const unfinishedBlock = sse.replace(
      event('content_block_stop', { type: 'content_block_stop', index: 4 }),
      '',
    );
    const truncatedFrame = sse.slice(0, sse.length - 1);

    for (const invalid of [malformedJson, missingIndex, duplicateIndex, unfinishedBlock, truncatedFrame]) {
      expect(captureAnthropicHostedReplay(invalid)).toBeUndefined();
    }
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
    expect(JSON.stringify(restored.messages[0]?.content)).toBe(JSON.stringify(rawContent()));
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

  it('delivers an unpaired hosted response without poisoning the next provider request', async () => {
    const fixture = fakeSession(unpairedSse);
    const firstEvents = [];
    const first = fixture.agent.streamFunction(MODEL as never, { messages: [], tools: [] } as never, { fetch: fixture.fetch } as never);
    for await (const current of first) firstEvents.push(current);

    const done = firstEvents.find((current) => current.type === 'done');
    expect(done?.type).toBe('done');
    expect(done?.type === 'done' ? anthropicHostedReplayMetadata(done.message) : 'unset').toBeUndefined();
    expect(firstEvents.some((current) => current.type === 'error')).toBe(false);

    const secondEvents = [];
    const second = fixture.agent.streamFunction(
      MODEL as never,
      { messages: [done?.type === 'done' ? done.message : assistant(null)], tools: [] } as never,
      { fetch: fixture.fetch } as never,
    );
    for await (const current of second) secondEvents.push(current);
    expect(secondEvents.some((current) => current.type === 'error')).toBe(false);
    expect(fixture.fetch).toHaveBeenCalledTimes(2);
  });

  it('uses the final successful capture when an earlier provider attempt failed', async () => {
    const final = assistant(null);
    const native = vi.fn((_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const first = await options.fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
        });
        await first.text().catch(() => undefined);
        const second = await options.fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
        });
        await second.text();
        stream.push({ type: 'done', reason: 'toolUse', message: final as never });
        stream.end();
      })();
      return stream;
    });
    const failedBody = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error('first provider stream failed')); },
    });
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(failedBody, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
      .mockResolvedValueOnce(new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const agent = { streamFunction: native };
    const replay = createAnthropicHostedToolReplay(MODEL as never);
    replay.install({ agent, subscribe: () => () => {} } as unknown as AgentSession);

    const events = [];
    const stream = agent.streamFunction(MODEL as never, { messages: [], tools: [] } as never, { fetch } as never);
    for await (const current of stream) events.push(current);

    expect(events.some((current) => current.type === 'error')).toBe(false);
    const done = events.find((current) => current.type === 'done');
    expect(done?.type === 'done' ? anthropicHostedReplayMetadata(done.message) : undefined).toEqual(metadata());
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps replay metadata when the consumer cancels after message_stop instead of reading EOF', async () => {
    const final = assistant(null);
    const native = vi.fn((_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const response = await options.fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
        });
        const reader = response.body!.getReader();
        await reader.read();
        await reader.cancel('response complete');
        stream.push({ type: 'done', reason: 'toolUse', message: final as never });
        stream.end();
      })();
      return stream;
    });
    const agent = { streamFunction: native };
    const replay = createAnthropicHostedToolReplay(MODEL as never);
    replay.install({ agent, subscribe: () => () => {} } as unknown as AgentSession);
    const fetch = vi.fn(async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }));

    const events = [];
    const stream = agent.streamFunction(MODEL as never, { messages: [], tools: [] } as never, { fetch } as never);
    for await (const current of stream) events.push(current);

    expect(events.some((current) => current.type === 'error')).toBe(false);
    const done = events.find((current) => current.type === 'done');
    expect(done?.type === 'done' ? anthropicHostedReplayMetadata(done.message) : undefined).toEqual(metadata());
  });

  it('delivers a finished answer but blocks the next request after unsafe hosted capture', async () => {
    // Capture becomes invalid BEFORE the first hosted block, but must keep observing later complete frames
    // and latch the unsafe boundary once server_tool_use appears.
    const unsafeSse = `event: broken\ndata: {not-json}\n\nevent: broken-again\ndata: {still-not-json}\n\n${sse}`;
    const fixture = fakeSession(unsafeSse);
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
    expect(done?.type === 'done' ? done.message.content : []).toEqual(fixture.final.content);
    expect(done?.type === 'done' ? anthropicHostedReplayMetadata(done.message) : 'unset').toBeUndefined();

    const nextEvents = [];
    const next = fixture.agent.streamFunction(
      { id: 'claude-opus-5', provider: 'anthropic', api: 'anthropic-messages' } as never,
      { messages: [assistant(null)], tools: [] } as never,
      { fetch: fixture.fetch } as never,
    );
    for await (const current of next) nextEvents.push(current);
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
    expect(nextEvents.at(-1)?.type).toBe('error');
    expect(nextEvents.at(-1)?.type === 'error' ? nextEvents.at(-1)?.error.errorMessage : '')
      .toContain('could not be captured safely');

    const persistedUnsafe = JSON.parse(JSON.stringify(done?.type === 'done' ? done.message : null));
    const respawned = fakeSession(sse, [wireAssistant()]);
    const respawnEvents = [];
    const afterRespawn = respawned.agent.streamFunction(
      { id: 'claude-opus-5', provider: 'anthropic', api: 'anthropic-messages' } as never,
      { messages: [persistedUnsafe], tools: [] } as never,
      { fetch: respawned.fetch } as never,
    );
    for await (const current of afterRespawn) respawnEvents.push(current);
    expect(respawned.fetch).not.toHaveBeenCalled();
    expect(respawnEvents.at(-1)?.type === 'error' ? respawnEvents.at(-1)?.error.errorMessage : '')
      .toContain('could not be captured safely');
  });

  it('allows PI compaction to remove an unsafe durable turn and reopen the conversation', async () => {
    const unsafeSse = `event: broken\ndata: {not-json}\n\n${sse}`;
    const fixture = fakeSession(unsafeSse);
    const firstEvents = [];
    const first = fixture.agent.streamFunction(MODEL as never, { messages: [], tools: [] } as never, { fetch: fixture.fetch } as never);
    for await (const current of first) firstEvents.push(current);
    const unsafe = firstEvents.find((current) => current.type === 'done');
    expect(unsafe?.type).toBe('done');

    fixture.fetch.mockImplementation(async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const controller = new AbortController();
    fixture.handlers.get('session_before_compact')?.({ signal: controller.signal });
    const recoveryEvents = [];
    const recovery = fixture.agent.streamFunction(
      MODEL as never,
      { messages: [unsafe?.type === 'done' ? unsafe.message : null], tools: [] } as never,
      { fetch: fixture.fetch, signal: controller.signal } as never,
    );
    for await (const current of recovery) recoveryEvents.push(current);
    expect(recoveryEvents.some((current) => current.type === 'error')).toBe(false);

    fixture.emit({ type: 'compaction_end', aborted: false, result: { summary: 'safe compacted context' } });
    const resumedEvents = [];
    const resumed = fixture.agent.streamFunction(MODEL as never, { messages: [], tools: [] } as never, { fetch: fixture.fetch } as never);
    for await (const current of resumed) resumedEvents.push(current);
    expect(resumedEvents.some((current) => current.type === 'error')).toBe(false);
    expect(fixture.fetch).toHaveBeenCalledTimes(3);
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

  it('registers compaction recovery before provider restoration', () => {
    const handlers = new Map<string, (event: any) => unknown>();
    const replay = createAnthropicHostedToolReplay(MODEL as never);
    replay.extension({ on: vi.fn((name: string, handler: (event: any) => unknown) => handlers.set(name, handler)) } as unknown as ExtensionAPI);
    expect([...handlers.keys()]).toEqual(['session_before_compact', 'before_provider_request']);
  });
});
