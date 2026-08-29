import { describe, expect, it, vi } from 'vitest';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { Api, Model } from '@earendil-works/pi-ai';
import { convertToLlm } from '@earendil-works/pi-coding-agent';
import { convertResponsesMessages } from '@earendil-works/pi-ai/api/openai-responses-shared';
import type { AgentSession, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { BrainStore } from '../../src/store/brainStore.js';
import { openDb } from '../../src/store/db.js';
import { rehydrate } from '../../src/brain/persistence.js';
import {
  COMPACTION_UNAVAILABLE_NOTE,
  accountIdFromToken,
  buildCompactionRequestBody,
  createRemoteCompactionV2,
  decodeCompactionMarker,
  encodeCompactionSummary,
  installCompactionMarkerSanitizer,
  parseCompactionStream,
  resolveCodexUrl,
  substituteCompactionItems,
} from '../../src/brain/session/remoteCompactionV2.js';

const BLOB = 'gAAAAABmockblobcontent==';
const MODEL = {
  id: 'gpt-5.5', provider: 'openai-codex', api: 'openai-codex-responses',
  contextWindow: 200_000, maxTokens: 8_000, input: ['text'], baseUrl: undefined,
} as unknown as Model<Api>;

/** A JWT whose payload carries the account-id claim pi-ai reads. Only the payload segment is inspected,
 *  so the header and signature are filler. */
function token(claims: unknown): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `eyJhbGciOiJub25lIn0.${payload}.sig`;
}
const LIVE_TOKEN = token({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } });

/** Collects the handlers an extension registers, so each can be driven in isolation. */
function fakePi(): { api: ExtensionAPI; handlers: Map<string, Function[]> } {
  const handlers = new Map<string, Function[]>();
  const api = {
    on(event: string, handler: Function) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  } as unknown as ExtensionAPI;
  return { api, handlers };
}

function handler(handlers: Map<string, Function[]>, event: string, index = 0): Function {
  const found = handlers.get(event)?.[index];
  if (!found) throw new Error(`no handler registered for ${event}`);
  return found;
}

/** One SSE frame as the backend emits it. */
function sse(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}
const compactionItem = (blob: string) => ({ type: 'response.output_item.done', item: { id: 'c1', type: 'compaction', encrypted_content: blob } });
const completed = { type: 'response.completed', response: { id: 'resp_1' } };

function okResponse(body: string): Response {
  return { ok: true, status: 200, text: async () => body } as unknown as Response;
}

function preparation(over: Record<string, unknown> = {}) {
  return {
    firstKeptEntryId: 'entry-9',
    tokensBefore: 12_345,
    messagesToSummarize: [
      { role: 'user', content: [{ type: 'text', text: 'the phase-one code word is ALFA-771' }], timestamp: 1 },
    ],
    turnPrefixMessages: [],
    isSplitTurn: false,
    fileOps: { readFiles: [], modifiedFiles: [] },
    settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 2_000 },
    ...over,
  };
}

function deps(over: Record<string, unknown> = {}) {
  return {
    enabled: () => true,
    model: MODEL,
    systemPrompt: () => 'You are Elowen.',
    token: async () => LIVE_TOKEN,
    fetchImpl: vi.fn(async () => okResponse(sse([compactionItem(BLOB), completed]))) as unknown as typeof fetch,
    ...over,
  };
}

describe('remote compaction v2 — SSE parsing', () => {
  it('returns the blob when the stream completes carrying exactly one compaction item', () => {
    expect(parseCompactionStream(sse([compactionItem(BLOB), completed]))).toBe(BLOB);
  });

  it('refuses a stream with no compaction item', () => {
    expect(parseCompactionStream(sse([{ type: 'response.output_item.done', item: { type: 'message' } }, completed]))).toBeNull();
  });

  it('refuses a stream with two compaction items rather than picking one', () => {
    expect(parseCompactionStream(sse([compactionItem(BLOB), compactionItem('second'), completed]))).toBeNull();
  });

  it('refuses a stream that ends before response.completed', () => {
    expect(parseCompactionStream(sse([compactionItem(BLOB)]))).toBeNull();
  });

  it('ignores unparsable frames and keep-alives instead of throwing', () => {
    const body = `: keep-alive\n\ndata: not-json\n\n${sse([compactionItem(BLOB), completed])}data: [DONE]\n\n`;
    expect(parseCompactionStream(body)).toBe(BLOB);
  });
});

describe('remote compaction v2 — request body', () => {
  it('puts the compaction trigger last, after every converted history item', () => {
    const body = buildCompactionRequestBody({
      model: MODEL,
      systemPrompt: 'sys',
      messages: convertToLlm([
        { role: 'user', content: [{ type: 'text', text: 'first' }], timestamp: 1 },
        { role: 'user', content: [{ type: 'text', text: 'second' }], timestamp: 2 },
      ] as never),
    });
    const input = body.input as unknown[];
    expect(input.length).toBe(3);
    expect(input.at(-1)).toEqual({ type: 'compaction_trigger' });
    // …and nothing else is a trigger, so "last" is also "only".
    expect(input.filter((i) => (i as { type?: string }).type === 'compaction_trigger')).toHaveLength(1);
  });

  it('chains a previous blob as the FIRST input item, ahead of the new history', () => {
    const body = buildCompactionRequestBody({
      model: MODEL,
      systemPrompt: 'sys',
      messages: convertToLlm([{ role: 'user', content: [{ type: 'text', text: 'later' }], timestamp: 1 }] as never),
      previousBlob: 'previous-blob',
    });
    const input = body.input as unknown[];
    expect(input[0]).toEqual({ type: 'compaction', encrypted_content: 'previous-blob' });
    expect(input.at(-1)).toEqual({ type: 'compaction_trigger' });
  });

  it('mirrors the fields pi-ai sends, so the blob describes the conversation the session actually has', () => {
    const body = buildCompactionRequestBody({ model: MODEL, systemPrompt: 'sys', messages: [] });
    expect(body).toMatchObject({ model: 'gpt-5.5', store: false, stream: true, instructions: 'sys', include: ['reasoning.encrypted_content'] });
    expect(body).not.toHaveProperty('service_tier');
  });

  it('applies the account Fast preference to the direct Codex compaction request', () => {
    expect(buildCompactionRequestBody({ model: MODEL, systemPrompt: 'sys', messages: [], fast: true }))
      .toMatchObject({ service_tier: 'priority' });
  });
});

describe('remote compaction v2 — marker encoding', () => {
  it('round-trips the blob and the model slug through a plain string', () => {
    const summary = encodeCompactionSummary({ model: 'gpt-5.5', blob: BLOB });
    expect(decodeCompactionMarker(summary)).toEqual({ model: 'gpt-5.5', blob: BLOB });
  });

  it('keeps a human-readable explanation beside the marker, for the clients that render the summary', () => {
    expect(encodeCompactionSummary({ model: 'gpt-5.5', blob: BLOB })).toMatch(/compacted by the provider/);
  });

  it('returns null for a plain text summary and for a corrupt marker', () => {
    expect(decodeCompactionMarker('an ordinary summary of the conversation')).toBeNull();
    expect(decodeCompactionMarker('<elowen-remote-compaction-v2>{not json}</elowen-remote-compaction-v2>')).toBeNull();
    expect(decodeCompactionMarker('<elowen-remote-compaction-v2>{"model":"m"}</elowen-remote-compaction-v2>')).toBeNull();
  });
});

describe('remote compaction v2 — auth and endpoint derivation', () => {
  it('reads the ChatGPT account id out of the token claim', () => {
    expect(accountIdFromToken(LIVE_TOKEN)).toBe('acct-1');
    expect(accountIdFromToken(token({ other: 1 }))).toBeNull();
    expect(accountIdFromToken('not-a-jwt')).toBeNull();
  });

  it('resolves every accepted base-url shape onto the same endpoint', () => {
    expect(resolveCodexUrl(undefined)).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(resolveCodexUrl('https://example.test/backend-api/')).toBe('https://example.test/backend-api/codex/responses');
    expect(resolveCodexUrl('https://example.test/backend-api/codex')).toBe('https://example.test/backend-api/codex/responses');
    expect(resolveCodexUrl('https://example.test/backend-api/codex/responses')).toBe('https://example.test/backend-api/codex/responses');
  });
});

describe('remote compaction v2 — session_before_compact', () => {
  it('replaces PI\'s summarization with a marker carrying the blob and the preparation\'s cut point', async () => {
    const { api, handlers } = fakePi();
    createRemoteCompactionV2(deps()).extension(api);
    const result = await handler(handlers, 'session_before_compact')({ preparation: preparation(), signal: undefined });
    expect(result?.compaction?.firstKeptEntryId).toBe('entry-9');
    expect(result?.compaction?.tokensBefore).toBe(12_345);
    expect(decodeCompactionMarker(result?.compaction?.summary ?? '')).toEqual({ model: 'gpt-5.5', blob: BLOB });
  });

  it('reports the exact body and terminal response without exposing request headers', async () => {
    const capture = {
      start: vi.fn(() => 'request-1'),
      response: vi.fn(),
      finish: vi.fn(),
    };
    const { api, handlers } = fakePi();
    createRemoteCompactionV2(deps({ capture })).extension(api);

    await handler(handlers, 'session_before_compact')({ preparation: preparation(), signal: undefined });

    expect(capture.start).toHaveBeenCalledWith(MODEL, expect.objectContaining({ model: 'gpt-5.5', input: expect.any(Array) }));
    expect(capture.response).toHaveBeenCalledWith('request-1', 200);
    expect(capture.finish).toHaveBeenCalledWith('request-1', { response: { encryptedContent: BLOB } });
    expect(JSON.stringify(capture.start.mock.calls[0]?.[1])).not.toContain('Bearer');
    expect(JSON.stringify(capture.start.mock.calls[0]?.[1])).not.toContain('acct-1');
  });

  it('sends the split-turn prefix inside the blob too, since PI drops it from the live context', async () => {
    const fetchImpl = vi.fn(async () => okResponse(sse([compactionItem(BLOB), completed])));
    const { api, handlers } = fakePi();
    createRemoteCompactionV2(deps({ fetchImpl })).extension(api);
    await handler(handlers, 'session_before_compact')({
      preparation: preparation({
        isSplitTurn: true,
        turnPrefixMessages: [{ role: 'user', content: [{ type: 'text', text: 'PREFIX-ONLY-TEXT' }], timestamp: 2 }],
      }),
      signal: undefined,
    });
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as { body: string }).body) as { input: unknown[] };
    expect(JSON.stringify(body.input)).toContain('PREFIX-ONLY-TEXT');
  });

  it('chains the previous marker\'s blob into the new compaction request', async () => {
    const fetchImpl = vi.fn(async () => okResponse(sse([compactionItem('newer'), completed])));
    const { api, handlers } = fakePi();
    createRemoteCompactionV2(deps({ fetchImpl })).extension(api);
    await handler(handlers, 'session_before_compact')({
      preparation: preparation({ previousSummary: encodeCompactionSummary({ model: 'gpt-5.5', blob: 'older-blob' }) }),
      signal: undefined,
    });
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as { body: string }).body) as { input: unknown[] };
    expect(body.input[0]).toEqual({ type: 'compaction', encrypted_content: 'older-blob' });
  });

  it('returns UNDEFINED when the provider yields no blob, handing the compaction back to PI', async () => {
    const { api, handlers } = fakePi();
    createRemoteCompactionV2(deps({ fetchImpl: async () => ({ ok: false, status: 500, text: async () => '' }) })).extension(api);
    const result = await handler(handlers, 'session_before_compact')({ preparation: preparation(), signal: undefined });
    // Not `{ cancel: true }`, not a thrown error: only `undefined` makes PI run its own text summary.
    expect(result).toBeUndefined();
  });

  it('returns undefined without calling the provider when the operator switch is off', async () => {
    const fetchImpl = vi.fn();
    const { api, handlers } = fakePi();
    createRemoteCompactionV2(deps({ enabled: () => false, fetchImpl })).extension(api);
    expect(await handler(handlers, 'session_before_compact')({ preparation: preparation(), signal: undefined })).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns undefined when no ChatGPT token can be resolved', async () => {
    const fetchImpl = vi.fn();
    const { api, handlers } = fakePi();
    createRemoteCompactionV2(deps({ token: async () => undefined, fetchImpl })).extension(api);
    expect(await handler(handlers, 'session_before_compact')({ preparation: preparation(), signal: undefined })).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('clears a marker previousSummary on the fallback path, so PI never summarizes a base64 blob', async () => {
    const { api, handlers } = fakePi();
    createRemoteCompactionV2(deps({ fetchImpl: async () => ({ ok: false, status: 500, text: async () => '' }) })).extension(api);
    const prep = preparation({ previousSummary: encodeCompactionSummary({ model: 'gpt-5.5', blob: BLOB }) });
    await handler(handlers, 'session_before_compact')({ preparation: prep, signal: undefined });
    expect(prep.previousSummary).toBeUndefined();
  });

  it('leaves a genuine text previousSummary alone on the fallback path', async () => {
    const { api, handlers } = fakePi();
    createRemoteCompactionV2(deps({ fetchImpl: async () => ({ ok: false, status: 500, text: async () => '' }) })).extension(api);
    const prep = preparation({ previousSummary: 'the user asked about billing' });
    await handler(handlers, 'session_before_compact')({ preparation: prep, signal: undefined });
    expect(prep.previousSummary).toBe('the user asked about billing');
  });
});

describe('remote compaction v2 — before_provider_request', () => {
  const markerItem = () => ({
    role: 'user',
    content: [{ type: 'input_text', text: `prefix\n<summary>\n${encodeCompactionSummary({ model: 'gpt-5.5', blob: BLOB })}\n</summary>` }],
  });

  it('replaces the marker-carrying user item with a real compaction item', () => {
    const { api, handlers } = fakePi();
    createRemoteCompactionV2(deps()).extension(api);
    const payload = { model: 'gpt-5.5', input: [markerItem(), { role: 'user', content: [{ type: 'input_text', text: 'hello' }] }] };
    const next = handler(handlers, 'before_provider_request')({ payload }) as { input: unknown[] } | undefined;
    expect(next?.input?.[0]).toEqual({ type: 'compaction', encrypted_content: BLOB });
    expect(next?.input?.[1]).toEqual({ role: 'user', content: [{ type: 'input_text', text: 'hello' }] });
    // The blob must exist ONLY as encrypted_content — never as text anywhere in the payload.
    expect(JSON.stringify(next.input[1])).not.toContain(BLOB);
  });

  it('leaves a payload with no marker untouched', () => {
    const { api, handlers } = fakePi();
    createRemoteCompactionV2(deps()).extension(api);
    expect(handler(handlers, 'before_provider_request')({ payload: { input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] } })).toBeUndefined();
  });

  it('leaves a non-Responses payload untouched', () => {
    const { api, handlers } = fakePi();
    createRemoteCompactionV2(deps()).extension(api);
    expect(handler(handlers, 'before_provider_request')({ payload: { messages: [] } })).toBeUndefined();
    expect(handler(handlers, 'before_provider_request')({ payload: null })).toBeUndefined();
  });

  it('does not substitute at all when the operator switch is off', () => {
    const { api, handlers } = fakePi();
    createRemoteCompactionV2(deps({ enabled: () => false })).extension(api);
    expect(handler(handlers, 'before_provider_request')({ payload: { input: [markerItem()] } })).toBeUndefined();
  });

  it('swaps a rejected blob for the honest note instead of sending it as text', () => {
    const rejected = new Set([BLOB]);
    const next = substituteCompactionItems([markerItem()], (blob) => rejected.has(blob));
    expect(next).toEqual([{ role: 'user', content: [{ type: 'input_text', text: COMPACTION_UNAVAILABLE_NOTE }] }]);
    expect(JSON.stringify(next)).not.toContain(BLOB);
  });
});

describe('remote compaction v2 — stale blob recovery', () => {
  /** A stream that fails the way pi-ai reports a rejected blob: a single error event, nothing before it. */
  function refusingStream() {
    const s = createAssistantMessageEventStream();
    queueMicrotask(() => {
      s.push({
        type: 'error', reason: 'error',
        error: { errorMessage: 'The encrypted content gAAA...AAAA could not be verified. Reason: Encrypted content could not be decrypted or parsed.' },
      } as never);
      s.end();
    });
    return s;
  }
  function okStream(text: string) {
    const s = createAssistantMessageEventStream();
    queueMicrotask(() => {
      s.push({ type: 'start', partial: {} } as never);
      s.push({ type: 'done', reason: 'stop', message: { role: 'assistant', content: [{ type: 'text', text }] } } as never);
      s.end();
    });
    return s;
  }
  const markerContext = () => ({
    messages: convertToLlm([
      { role: 'compactionSummary', summary: encodeCompactionSummary({ model: 'gpt-5.5', blob: BLOB }), tokensBefore: 1, timestamp: 1 },
      { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 2 },
    ] as never),
  });
  function install(streamFunction: unknown, over: Record<string, unknown> = {}) {
    const remote = createRemoteCompactionV2(deps(over));
    const session = { agent: { streamFunction } } as unknown as AgentSession;
    remote.install(session);
    return { remote, session: session as unknown as { agent: { streamFunction: Function } } };
  }

  it('retries the request once and forwards only the second attempt\'s events', async () => {
    const calls: number[] = [];
    const onStaleBlobRetry = vi.fn();
    let attempt = 0;
    const { session } = install(
      () => { attempt += 1; calls.push(attempt); return attempt === 1 ? refusingStream() : okStream('recovered'); },
      { onStaleBlobRetry },
    );
    const out = session.agent.streamFunction(MODEL, markerContext(), undefined);
    const events: string[] = [];
    for await (const event of out as AsyncIterable<{ type: string }>) events.push(event.type);
    expect(calls).toEqual([1, 2]);
    expect(onStaleBlobRetry).toHaveBeenCalledOnce();
    // The refused attempt is invisible to the caller: no error event leaked out ahead of the retry.
    expect(events).toEqual(['start', 'done']);
  });

  it('drops the blob from the retry payload, replacing it with the note', async () => {
    const { remote, session } = install(() => refusingStream());
    const { api, handlers } = fakePi();
    remote.extension(api);
    const before = handler(handlers, 'before_provider_request')({
      payload: { input: [{ role: 'user', content: [{ type: 'input_text', text: encodeCompactionSummary({ model: 'gpt-5.5', blob: BLOB }) }] }] },
    }) as { input: unknown[] } | undefined;
    expect(before?.input?.[0]).toEqual({ type: 'compaction', encrypted_content: BLOB });

    const out = session.agent.streamFunction(MODEL, markerContext(), undefined);
    for await (const _ of out as AsyncIterable<unknown>) { /* drain */ }

    const after = handler(handlers, 'before_provider_request')({
      payload: { input: [{ role: 'user', content: [{ type: 'input_text', text: encodeCompactionSummary({ model: 'gpt-5.5', blob: BLOB }) }] }] },
    }) as { input: unknown[] } | undefined;
    expect(after?.input?.[0]).toEqual({ role: 'user', content: [{ type: 'input_text', text: COMPACTION_UNAVAILABLE_NOTE }] });
  });

  it('does not retry an unrelated provider error', async () => {
    let attempt = 0;
    const failing = () => {
      const s = createAssistantMessageEventStream();
      queueMicrotask(() => { s.push({ type: 'error', reason: 'error', error: { errorMessage: 'You have hit your ChatGPT usage limit.' } } as never); s.end(); });
      return s;
    };
    const { session } = install(() => { attempt += 1; return failing(); });
    const out = session.agent.streamFunction(MODEL, markerContext(), undefined);
    const events: string[] = [];
    for await (const event of out as AsyncIterable<{ type: string }>) events.push(event.type);
    expect(attempt).toBe(1);
    expect(events).toEqual(['error']);
  });

  it('hands back the native stream object itself when the request carries no blob', () => {
    const native = createAssistantMessageEventStream();
    const { session } = install(() => native);
    const plain = { messages: convertToLlm([{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 }] as never) };
    expect(session.agent.streamFunction(MODEL, plain, undefined)).toBe(native);
  });
});

describe('remote compaction v2 — cross-provider sanitizer', () => {
  const messages = () => [
    { role: 'compactionSummary', summary: encodeCompactionSummary({ model: 'gpt-5.5', blob: BLOB }), tokensBefore: 1, timestamp: 1 },
    { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 2 },
  ];

  it('strips a marker a session can no longer honor, so the blob never travels as text', () => {
    const { api, handlers } = fakePi();
    installCompactionMarkerSanitizer(api, () => false);
    const result = handler(handlers, 'context')({ messages: messages() }) as { messages: { summary?: string }[] } | undefined;
    expect(result?.messages?.[0]?.summary).toBe(COMPACTION_UNAVAILABLE_NOTE);
    expect(JSON.stringify(result?.messages ?? [])).not.toContain(BLOB);
  });

  it('leaves the marker in place for a session that CAN restore it', () => {
    const { api, handlers } = fakePi();
    installCompactionMarkerSanitizer(api, () => true);
    expect(handler(handlers, 'context')({ messages: messages() })).toBeUndefined();
  });

  it('leaves an ordinary text summary alone even on an unusable session', () => {
    const { api, handlers } = fakePi();
    installCompactionMarkerSanitizer(api, () => false);
    const plain = [{ role: 'compactionSummary', summary: 'the user asked about billing', tokensBefore: 1, timestamp: 1 }];
    expect(handler(handlers, 'context')({ messages: plain })).toBeUndefined();
  });
});

describe('remote compaction v2 — storage and rehydration', () => {
  it('survives the store round trip and becomes a compaction item, never raw text', () => {
    const db = openDb(':memory:');
    const store = new BrainStore(db);
    store.createSession({ id: 's1', userId: 1, model: 'gpt-5.5' });
    store.appendMessage({ id: 'old', sessionId: 's1', parentId: null, role: 'user', content: { role: 'user', content: 'ancient question' } });
    store.appendMessage({ id: 'keep', sessionId: 's1', parentId: null, role: 'user', content: { role: 'user', content: 'recent question' } });
    const summary = encodeCompactionSummary({ model: 'gpt-5.5', blob: BLOB });
    store.compactSessionMessages('s1', { id: 'c', role: 'compaction', content: { role: 'compactionSummary', summary, tokensBefore: 42 } }, 1);

    // Rehydrate exactly as a respawn does, then walk the real conversion chain to a provider payload.
    const manager = rehydrate(store, 's1', '/tmp');
    const agentMessages = manager.buildSessionContext().messages;
    expect(agentMessages.some((m) => m.role === 'compactionSummary')).toBe(true);
    const input = convertResponsesMessages(
      MODEL, { messages: convertToLlm(agentMessages) }, new Set(['openai', 'openai-codex', 'opencode']), { includeSystemPrompt: false },
    ) as unknown[];
    // Before the hook, the blob IS present as text — which is precisely what the hook has to fix.
    expect(JSON.stringify(input)).toContain(BLOB);

    const { api, handlers } = fakePi();
    createRemoteCompactionV2(deps()).extension(api);
    const next = handler(handlers, 'before_provider_request')({ payload: { model: 'gpt-5.5', input } }) as { input: unknown[] } | undefined;

    expect(next?.input ?? []).toContainEqual({ type: 'compaction', encrypted_content: BLOB });
    // …and the blob appears nowhere else: no item still carries it as readable text.
    const asText = (next?.input ?? []).filter((item) => (item as { type?: string }).type !== 'compaction');
    expect(JSON.stringify(asText)).not.toContain(BLOB);
    expect(JSON.stringify(asText)).toContain('recent question');
    db.close();
  });
});
