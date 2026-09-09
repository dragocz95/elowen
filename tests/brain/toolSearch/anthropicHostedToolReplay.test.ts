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

/** The tool block a request replaying these fixtures actually carries. It names every tool their
 *  hosted-search results reference: Anthropic validates a replayed `tool_reference` against this array, so
 *  a request offering none of them could not carry the reference either — restore drops it instead of
 *  sending a reference the provider will refuse the whole request over. */
const REQUEST_TOOLS = [
  { name: 'DocsSearch', input_schema: { type: 'object' } },
  { name: 'Bash', input_schema: { type: 'object' } },
];

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
/** The common production shape of an uncapturable hosted response: the search that never got its result
 *  sits BEFORE the only signed thinking block, so continuing without the hosted blocks leaves that block's
 *  body exactly as Anthropic produced it and the next request is accepted. */
const unpairedOutsideThinkingSse = [
  block(0, { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_bm25', input: {} }, [
    { type: 'input_json_delta', partial_json: '{"query":"Elowen docs"}' },
  ]),
  block(1, { type: 'text', text: 'Searching.' }),
  block(2, { type: 'thinking', thinking: 'first', signature: SIGNATURE_A }),
  block(3, { type: 'tool_use', id: 'toolu_docs', name: 'DocsSearch', input: { query: 'slash commands' } }),
  event('message_stop', { type: 'message_stop' }),
].join('');
const mismatchedSse = sse.replace('"tool_use_id":"srvtoolu_1"', '"tool_use_id":"srvtoolu_unmatched"');
const orphanResultSse = [
  block(0, { type: 'text', text: 'Searching.' }),
  block(1, rawContent()[3]!),
  block(2, { type: 'tool_use', id: 'toolu_docs', name: 'DocsSearch', input: { query: 'slash commands' } }),
  event('message_stop', { type: 'message_stop' }),
].join('');
const duplicateResultSse = [
  block(0, { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_bm25', input: { query: 'Elowen docs' } }),
  block(1, rawContent()[3]!),
  block(2, rawContent()[3]!),
  block(3, { type: 'tool_use', id: 'toolu_docs', name: 'DocsSearch', input: { query: 'slash commands' } }),
  event('message_stop', { type: 'message_stop' }),
].join('');
const multiplePairsContent = [
  { type: 'redacted_thinking', data: 'redacted-thinking' },
  { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_bm25', input: { query: 'docs' } },
  { type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'tool_search_tool_search_result', tool_references: [] } },
  { type: 'server_tool_use', id: 'srvtoolu_2', name: 'tool_search_tool_regex', input: { pattern: 'Bash' } },
  { type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_2', content: { type: 'tool_search_tool_search_result', tool_references: [{ type: 'tool_reference', tool_name: 'Bash' }] } },
];
const multiplePairsSse = [
  block(0, multiplePairsContent[0]!),
  block(1, multiplePairsContent[1]!),
  block(2, multiplePairsContent[2]!),
  block(3, multiplePairsContent[3]!),
  block(4, multiplePairsContent[4]!),
  event('message_stop', { type: 'message_stop' }),
].join('');
const genericServerContent = [
  { type: 'text', text: 'I will fetch and inspect in parallel.' },
  { type: 'server_tool_use', id: 'srvtoolu_web', name: 'web_fetch', input: { url: 'https://example.test' } },
  { type: 'tool_use', id: 'toolu_probe', name: 'probe', input: {} },
];
const genericServerSse = [
  block(0, genericServerContent[0]!),
  block(1, genericServerContent[1]!),
  block(2, genericServerContent[2]!),
  event('message_stop', { type: 'message_stop' }),
].join('');
const genericServerResultContent = [
  { type: 'web_fetch_tool_result', tool_use_id: 'srvtoolu_web', content: { type: 'web_fetch_result', url: 'https://example.test' } },
  { type: 'text', text: 'Fetched.' },
];
const genericServerResultSse = [
  block(0, genericServerResultContent[0]!),
  block(1, genericServerResultContent[1]!),
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

const assistantWith = (content: unknown[], meta: AnthropicHostedReplayMetadata) => ({
  ...assistant(null), content, anthropicHostedToolReplay: meta,
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

  it('keeps no replay data for an incomplete pair the conversation can simply continue without', () => {
    for (const invalid of [unpairedOutsideThinkingSse, orphanResultSse, duplicateResultSse]) {
      expect(captureAnthropicHostedReplay(invalid)).toBeUndefined();
    }
  });

  it('captures an incomplete pair that splits signed thinking, marked as unpaired', () => {
    for (const split of [unpairedSse, mismatchedSse]) {
      const captured = captureAnthropicHostedReplay(split);
      expect(captured?.unpaired).toBe(true);
      expect(captured?.content.some((block) => block.type === 'server_tool_use')).toBe(true);
    }
    expect(captureAnthropicHostedReplay(unpairedSse)?.content).toEqual(unpairedContent());
  });

  it('ignores already-poisoned tool-search metadata during rehydration', () => {
    const poisoned = assistant({ v: 1, content: unpairedContent() });
    const payload = { model: 'claude-opus-5', messages: [wireAssistant()], tools: [] };
    expect(anthropicHostedReplayMetadata(poisoned as never)).toBeUndefined();
    expect(restoreAnthropicHostedReplay(payload, [poisoned], 'claude-opus-5')).toBeUndefined();
    expect(verifyAnthropicHostedReplay(payload, [poisoned], 'claude-opus-5')).toBe(true);
  });

  it('restores multiple tool-search pairs around PI redacted thinking verbatim', () => {
    const captured = captureAnthropicHostedReplay(multiplePairsSse)!;
    expect(captured.content).toEqual(multiplePairsContent);
    const stored = assistantWith([
      { type: 'thinking', thinking: '[Reasoning redacted]', thinkingSignature: 'redacted-thinking', redacted: true },
    ], captured);
    const payload = {
      model: 'claude-opus-5',
      messages: [{ role: 'assistant', content: [{ type: 'redacted_thinking', data: 'redacted-thinking' }] }],
      tools: REQUEST_TOOLS,
    };
    const restored = restoreAnthropicHostedReplay(payload, [stored], 'claude-opus-5') as typeof payload;
    expect(restored.messages[0]?.content).toEqual(multiplePairsContent);
    expect(verifyAnthropicHostedReplay(restored, [stored], 'claude-opus-5')).toBe(true);
  });

  it('restores a mixed generic server call and its result-only continuation across assistant messages', () => {
    const first = captureAnthropicHostedReplay(genericServerSse)!;
    const continuation = captureAnthropicHostedReplay(genericServerResultSse)!;
    expect(first.content).toEqual(genericServerContent);
    expect(continuation.content).toEqual(genericServerResultContent);

    const storedFirst = assistantWith([
      genericServerContent[0],
      { type: 'toolCall', id: 'toolu_probe', name: 'probe', arguments: {} },
    ], first);
    const storedContinuation = assistantWith([{ type: 'text', text: 'Fetched.' }], continuation);
    const payload = {
      model: 'claude-opus-5',
      messages: [
        { role: 'assistant', content: [genericServerContent[0], { type: 'tool_use', id: 'toolu_probe', name: 'probe', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_probe', content: 'ok' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Fetched.' }] },
      ],
      tools: [],
    };
    const restored = restoreAnthropicHostedReplay(payload, [storedFirst, storedContinuation], 'claude-opus-5') as typeof payload;
    expect(restored.messages[0]?.content).toEqual(genericServerContent);
    expect(restored.messages[2]?.content).toEqual(genericServerResultContent);
    expect(verifyAnthropicHostedReplay(restored, [storedFirst, storedContinuation], 'claude-opus-5')).toBe(true);
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
      tools: REQUEST_TOOLS,
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
    const payload = { model: 'claude-opus-5', messages: [wireAssistant()], tools: REQUEST_TOOLS };
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

  // The production failure this pins (delegated children sub-dlg-febd1645, sub-dlg-88852844 and
  // sub-dlg-f5b4a8b7 on claude-opus-5, 9 Sep 2026, msg_011CesK6tzwt9MpepFHEqmaa and siblings): each child's
  // FIRST answer was a `tool_use` response whose incomplete search pair sat between signed thinking blocks.
  // Dropping the hosted blocks had already been shown to end in "400 messages.1.content.6: `thinking` or
  // `redacted_thinking` blocks in the latest assistant message cannot be modified", so the shim latched a
  // fail-closed marker — and then refused every later request of that child before it reached the network,
  // which the SDK reported as a bare `Connection error.` The child was dead from its first turn on, and each
  // DelegateContinue into it died the same way. Replaying the response as Anthropic produced it is the only
  // body that can still satisfy that check, so it is captured instead of refused.
  it('replays an unpaired hosted turn verbatim instead of blocking every later request', async () => {
    const fixture = fakeSession(unpairedSse, [{ role: 'assistant', content: unpairedContent() }]);
    const firstEvents = [];
    const first = fixture.agent.streamFunction(MODEL as never, { messages: [], tools: [] } as never, { fetch: fixture.fetch } as never);
    for await (const current of first) firstEvents.push(current);

    const done = firstEvents.find((current) => current.type === 'done');
    expect(done?.type).toBe('done');
    expect(firstEvents.some((current) => current.type === 'error')).toBe(false);
    expect(done?.type === 'done' ? done.message.content : []).toEqual(fixture.final.content);
    const captured = done?.type === 'done' ? anthropicHostedReplayMetadata(done.message) : undefined;
    expect(captured).toEqual({ v: 1, content: unpairedContent(), unpaired: true });

    const restored = restoreAnthropicHostedReplay(
      { model: 'claude-opus-5', messages: [wireAssistant()], tools: REQUEST_TOOLS },
      [done?.type === 'done' ? done.message : assistant(null)],
      'claude-opus-5',
    ) as { messages: { content: unknown }[] };
    expect(restored.messages[0]?.content).toEqual(unpairedContent());

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

  it('delivers an unpaired hosted response without poisoning the next provider request', async () => {
    const fixture = fakeSession(unpairedOutsideThinkingSse);
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

  it('delivers a finished answer and keeps the session usable after an uncapturable hosted response', async () => {
    // Capture becomes invalid BEFORE the first hosted block, but must keep observing later complete frames
    // and mark the turn once server_tool_use appears.
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
      { messages: [done?.type === 'done' ? done.message : assistant(null)], tools: [] } as never,
      { fetch: fixture.fetch } as never,
    );
    for await (const current of next) nextEvents.push(current);
    expect(nextEvents.some((current) => current.type === 'error')).toBe(false);
    expect(fixture.fetch).toHaveBeenCalledTimes(2);
  });

  it('drops a refused hosted turn and retries once, then keeps later requests clean', async () => {
    const refusal = JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'messages.1.content.6: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified',
      },
    });
    const unsafeTurn = { ...assistant(null), anthropicHostedToolReplay: { v: 1, unsafe: true } };
    const fixture = fakeSession(sse, [
      { role: 'user', content: [{ type: 'text', text: 'Find the docs tool.' }] },
      wireAssistant(),
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_docs', content: 'result' }] },
    ]);
    fixture.fetch.mockImplementationOnce(async () => new Response(refusal, { status: 400, headers: { 'content-type': 'application/json' } }));

    const events = [];
    const stream = fixture.agent.streamFunction(
      MODEL as never, { messages: [unsafeTurn], tools: [] } as never, { fetch: fixture.fetch } as never,
    );
    for await (const current of stream) events.push(current);

    expect(events.some((current) => current.type === 'error')).toBe(false);
    expect(fixture.fetch).toHaveBeenCalledTimes(2);
    const retried = JSON.parse(fixture.fetch.mock.calls[1]![1].body);
    expect(retried.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Find the docs tool.' }] }]);

    const laterEvents = [];
    const later = fixture.agent.streamFunction(
      MODEL as never, { messages: [unsafeTurn], tools: [] } as never, { fetch: fixture.fetch } as never,
    );
    for await (const current of later) laterEvents.push(current);
    expect(laterEvents.some((current) => current.type === 'error')).toBe(false);
    expect(fixture.fetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fixture.fetch.mock.calls[2]![1].body).messages).toEqual(retried.messages);
  });

  it('passes an unrelated provider rejection through untouched', async () => {
    const overflow = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long' } });
    const unsafeTurn = { ...assistant(null), anthropicHostedToolReplay: { v: 1, unsafe: true } };
    const fixture = fakeSession(sse, [wireAssistant()]);
    fixture.fetch.mockImplementationOnce(async () => new Response(overflow, { status: 400, headers: { 'content-type': 'application/json' } }));

    const events = [];
    const stream = fixture.agent.streamFunction(
      MODEL as never, { messages: [unsafeTurn], tools: [] } as never, { fetch: fixture.fetch } as never,
    );
    for await (const current of stream) events.push(current);

    expect(fixture.fetch).toHaveBeenCalledTimes(1);
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

  it('blocks the network with a message naming the shim when extensions failed to restore a hosted turn', async () => {
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
    // The SDK renders a fetch throw as a bare `Connection error.`, so the message has to name the shim itself.
    expect(events.at(-1)?.type === 'error' ? events.at(-1)?.error.errorMessage : '')
      .toContain('Anthropic hosted tool-search replay shim: the final request lost persisted hosted-search blocks');
  });

  it('registers provider restoration', () => {
    const handlers = new Map<string, (event: any) => unknown>();
    const replay = createAnthropicHostedToolReplay(MODEL as never);
    replay.extension({ on: vi.fn((name: string, handler: (event: any) => unknown) => handlers.set(name, handler)) } as unknown as ExtensionAPI);
    expect([...handlers.keys()]).toEqual(['before_provider_request']);
  });
});
