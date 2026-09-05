import { describe, expect, it } from 'vitest';
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { inMemoryModelRuntime } from '../../src/brain/providers.js';
import { createAnthropicHostedToolReplay } from '../../src/brain/session/anthropicHostedToolReplay.js';
import { installAnthropicHostedToolSearch } from '../../src/brain/session/anthropicHostedToolSearch.js';
import { installOpenAIHostedToolSearch } from '../../src/brain/session/openAiHostedToolSearch.js';
import { ProviderRequestRecorder } from '../../src/brain/session/providerRequestRecorder.js';
import { setLogSink, type LogLevel } from '../../src/shared/logger.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { openDb } from '../../src/store/db.js';

/** Every line the recorder logs during a test, so a scenario can assert "no ERROR" the way the
 *  production incident was diagnosed — from the daemon log. */
function captureLog(): { lines: { level: LogLevel; message: string }[]; stop: () => void } {
  const lines: { level: LogLevel; message: string }[] = [];
  setLogSink({ push: (entry) => { if (entry.scope === 'provider-request-recorder') lines.push({ level: entry.level, message: entry.message }); } });
  return { lines, stop: () => setLogSink(undefined) };
}

const usage = (totalTokens: number) => ({
  input: totalTokens, output: 2, reasoning: 1, cacheRead: 3, cacheWrite: 4, totalTokens: totalTokens + 10,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
});

function message(model: Model<Api>, content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop', errorMessage?: string): AssistantMessage {
  return {
    role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
    usage: usage(10), stopReason, ...(errorMessage ? { errorMessage } : {}), timestamp: Date.now(),
  };
}

function stream(model: Model<Api>, answer: AssistantMessage) {
  const out = createAssistantMessageEventStream();
  queueMicrotask(() => {
    out.push({ type: 'start', partial: message(model, []) });
    if (answer.stopReason === 'error') out.push({ type: 'error', reason: 'error', error: answer });
    else out.push({ type: 'done', reason: answer.stopReason === 'toolUse' ? 'toolUse' : 'stop', message: answer });
  });
  return out;
}

async function fixture(options: {
  /** Reuse another fixture's store (a "next boot" on the same conversation) instead of opening a fresh DB. */
  brain?: BrainStore;
  enabled?: () => boolean;
  firstStatus?: number;
  provider?: string;
  api?: Api;
  modelId?: string;
  extensionFactories?: ((pi: ExtensionAPI) => void)[];
  payload?: (model: Model<Api>, context: Context, call: number) => Record<string, unknown>;
  repeatPayload?: (request: SimpleStreamOptions, model: Model<Api>, payload: Record<string, unknown>) => Promise<void>;
  run: (model: Model<Api>, context: Context, request: SimpleStreamOptions, call: number) => ReturnType<typeof stream> | Promise<ReturnType<typeof stream>>;
}) {
  const brain = options.brain ?? new BrainStore(openDb(':memory:'));
  if (!options.brain) brain.createSession({ id: 's1', userId: 7, model: 'chat-model', provider: 'configured' });
  const runtime = await inMemoryModelRuntime();
  const registry = new ModelRegistry(runtime);
  const api = options.api ?? `request-recorder-${Math.random()}` as Api;
  const provider = options.provider ?? 'wire';
  const modelId = options.modelId ?? 'chat-model';
  let call = 0;
  registry.registerProvider(provider, {
    name: 'Recorder provider', api, baseUrl: 'https://provider.invalid', apiKey: 'key',
    streamSimple: async (model, context, request = {}) => {
      call += 1;
      const initial = options.payload?.(model, context, call) ?? {
        model: model.id,
        instructions: context.systemPrompt,
        input: context.messages,
        tools: [{ type: 'function', name: call === 1 ? 'initial' : 'dynamic', parameters: { type: 'object' } }],
        parallel_tool_calls: true,
      };
      await request.onPayload?.(initial, model);
      const status = call === 1 ? (options.firstStatus ?? (options.run.name === 'retryRun' ? 429 : 200)) : 200;
      await request.onResponse?.({ status, headers: {} } as never, model);
      await options.repeatPayload?.(request, model, initial);
      return options.run(model, context, request, call);
    },
    models: [{
      id: modelId, name: modelId, reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 2_000, maxTokens: 512,
    }],
  });
  const model = registry.find(provider, modelId);
  if (!model) throw new Error('model missing');
  const recorder = new ProviderRequestRecorder({
    store: brain.providerRequests, sessionId: 's1', configuredProvider: 'configured', enabled: options.enabled ?? (() => true),
  });
  const transform = (pi: ExtensionAPI) => {
    pi.on('before_provider_request', (event) => ({ ...(event.payload as object), transformed: true }));
  };
  const settings = SettingsManager.inMemory({
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
    compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 10 },
  }, { projectTrusted: true });
  const cwd = process.cwd();
  const sessionManager = SessionManager.inMemory(cwd);
  const loader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager: settings, systemPrompt: 'recorder system',
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [...(options.extensionFactories ?? []), transform],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd, sessionManager, settingsManager: settings, modelRuntime: recorder.wrapRuntime(runtime), model,
    resourceLoader: loader,
    customTools: [defineTool({
      name: 'probe', label: 'Probe', description: 'Continue tool loop', parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: 'text', text: 'tool result' }], details: {} }),
    })],
    tools: ['probe'], noTools: 'builtin',
  });
  session.subscribe(recorder.observe);
  return { brain, session };
}

async function retryRun(model: Model<Api>, _context: Context, _request: SimpleStreamOptions, call: number) {
  return call === 1
    ? stream(model, message(model, [], 'error', 'rate limit exceeded'))
    : stream(model, message(model, [{ type: 'text', text: 'recovered' }]));
}

describe('ProviderRequestRecorder', () => {
  it('captures final transformed payloads and the exact dynamic tools in a tool-use loop', async () => {
    const f = await fixture({
      run: async (model, _context, _request, call) => call === 1
        ? stream(model, message(model, [{ type: 'toolCall', id: 'probe-1', name: 'probe', arguments: {} }], 'toolUse'))
        : stream(model, message(model, [{ type: 'text', text: 'done' }])),
    });

    await f.session.prompt('probe');

    const rows = f.brain.providerRequests.rows('s1');
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.status)).toEqual(['succeeded', 'succeeded']);
    const first = f.brain.providerRequests.reconstruct(rows[0]?.request_id as string) as { transformed: boolean; tools: { name: string }[] };
    const second = f.brain.providerRequests.reconstruct(rows[1]?.request_id as string) as { transformed: boolean; tools: { name: string }[] };
    expect(first.transformed).toBe(true);
    expect(first.tools[0]?.name).toBe('initial');
    expect(second.tools[0]?.name).toBe('dynamic');
    expect(rows[1]).toMatchObject({ input_tokens: 10, output_tokens: 2, reasoning_tokens: 1, cache_read_tokens: 3, cache_write_tokens: 4, total_tokens: 20, cost_usd: 0.25 });
  });

  it('captures the final OpenAI hosted Tool Search payload with the per-attempt tool schema', async () => {
    const f = await fixture({
      provider: 'openai-codex', api: 'openai-codex-responses' as Api, modelId: 'gpt-5.6-luna',
      extensionFactories: [(pi) => installOpenAIHostedToolSearch(pi, 'gpt-5.6-luna')],
      payload: (model, context, call) => ({
        model: model.id, instructions: context.systemPrompt, input: context.messages,
        tools: [{
          type: 'function', name: call === 1 ? 'probe' : 'dynamic_probe',
          parameters: { type: 'object', properties: { [`attempt_${call}`]: { type: 'string' } } },
        }],
      }),
      run: async (model, _context, _request, call) => call === 1
        ? stream(model, message(model, [{ type: 'toolCall', id: 'probe-1', name: 'probe', arguments: {} }], 'toolUse'))
        : stream(model, message(model, [{ type: 'text', text: 'done' }])),
    });

    await f.session.prompt('hosted search');

    const rows = f.brain.providerRequests.rows('s1');
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => ({ status: row.status, turn: row.turn_id, retry: row.retry_of }))).toEqual([
      { status: 'succeeded', turn: 'turn:1', retry: null },
      { status: 'succeeded', turn: 'turn:1', retry: null },
    ]);
    const first = f.brain.providerRequests.reconstruct(rows[0]!.request_id) as { transformed: boolean; tools: Record<string, unknown>[] };
    const second = f.brain.providerRequests.reconstruct(rows[1]!.request_id) as { transformed: boolean; tools: Record<string, unknown>[] };
    expect(first).toMatchObject({ transformed: true, tools: [
      { type: 'function', name: 'probe', defer_loading: true, parameters: { properties: { attempt_1: { type: 'string' } } } },
      { type: 'tool_search' },
    ] });
    expect(second).toMatchObject({ transformed: true, tools: [
      { type: 'function', name: 'dynamic_probe', defer_loading: true, parameters: { properties: { attempt_2: { type: 'string' } } } },
      { type: 'tool_search' },
    ] });
  });

  it('captures Anthropic deferred schemas after hosted replay restores the prior server-owned turn', async () => {
    const model = { id: 'claude-opus-5', provider: 'anthropic', api: 'anthropic-messages' } as Model<Api>;
    const replay = createAnthropicHostedToolReplay(model);
    const rawHostedContent = [
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_bm25', input: { query: 'probe' } },
      { type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'tool_search_tool_search_result', tool_references: [{ type: 'tool_reference', tool_name: 'probe' }] } },
      { type: 'tool_use', id: 'probe-1', name: 'probe', input: {} },
    ];
    const f = await fixture({
      provider: model.provider, api: model.api, modelId: model.id,
      extensionFactories: [
        (pi) => installAnthropicHostedToolSearch(pi, model.id),
        replay.extension,
      ],
      payload: (requestModel, context, call) => ({
        model: requestModel.id, system: context.systemPrompt, messages: context.messages,
        tools: [
          { name: 'ToolSearch', input_schema: { type: 'object' } },
          { name: call === 1 ? 'probe' : 'dynamic_probe', input_schema: { type: 'object', properties: { [`attempt_${call}`]: { type: 'integer' } } }, cache_control: { type: 'ephemeral' } },
        ],
      }),
      run: async (requestModel, _context, _request, call) => call === 1
        ? stream(requestModel, {
          ...message(requestModel, [{ type: 'toolCall', id: 'probe-1', name: 'probe', arguments: {} }], 'toolUse'),
          anthropicHostedToolReplay: { v: 1, content: rawHostedContent },
        } as AssistantMessage)
        : stream(requestModel, message(requestModel, [{ type: 'text', text: 'done' }])),
    });

    replay.install(f.session);
    await f.session.prompt('anthropic hosted search');

    const rows = f.brain.providerRequests.rows('s1');
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => ({ status: row.status, turn: row.turn_id }))).toEqual([
      { status: 'succeeded', turn: 'turn:1' },
      { status: 'succeeded', turn: 'turn:1' },
    ]);
    const first = f.brain.providerRequests.reconstruct(rows[0]!.request_id) as { transformed: boolean; messages: unknown[]; tools: Record<string, unknown>[] };
    const second = f.brain.providerRequests.reconstruct(rows[1]!.request_id) as { transformed: boolean; messages: { role?: string; content?: unknown[] }[]; tools: Record<string, unknown>[] };
    expect(first.tools).toEqual([
      { type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' },
      { name: 'probe', input_schema: { type: 'object', properties: { attempt_1: { type: 'integer' } } }, defer_loading: true },
    ]);
    expect(second.tools).toEqual([
      { type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' },
      { name: 'dynamic_probe', input_schema: { type: 'object', properties: { attempt_2: { type: 'integer' } } }, defer_loading: true },
    ]);
    expect(second.messages.find((entry) => entry.role === 'assistant')?.content).toEqual(rawHostedContent);
    expect(first.transformed).toBe(true);
    expect(second.transformed).toBe(true);
  });

  it('links PI auto-retry to the verified failed request', async () => {
    const f = await fixture({ run: retryRun });

    await f.session.prompt('retry');

    const rows = f.brain.providerRequests.rows('s1');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: 'error', http_status: 429 });
    expect(rows[1]).toMatchObject({ status: 'succeeded', retry_of: rows[0]?.request_id });
  });

  it('captures native PI compaction through the runtime seam that extension hooks omit', async () => {
    const f = await fixture({
      run: async (model, context) => stream(model, message(model, [{ type: 'text', text: context.systemPrompt?.includes('context summarization assistant') ? 'summary' : 'answer' }])),
    });
    await f.session.prompt(`one ${'history '.repeat(400)}`);
    await f.session.prompt(`two ${'history '.repeat(400)}`);

    await f.session.compact('manual capture');

    const rows = f.brain.providerRequests.rows('s1');
    const compact = rows.find((row) => row.kind === 'compaction');
    expect(compact).toMatchObject({
      status: 'succeeded', wire_provider: 'wire', model: 'chat-model', total_tokens: 20, cost_usd: 0.25,
    });
    expect(f.brain.providerRequests.reconstruct(compact?.request_id as string)).toMatchObject({ model: 'chat-model' });
  });

  it('correlates PI summarization retries to the failed compaction attempt', async () => {
    let compactionCalls = 0;
    const f = await fixture({
      run: async (model, context) => {
        const compacting = context.systemPrompt?.includes('context summarization assistant') === true;
        if (!compacting) return stream(model, message(model, [{ type: 'text', text: 'answer' }]));
        compactionCalls += 1;
        return compactionCalls === 1
          ? stream(model, message(model, [], 'error', 'rate limit exceeded'))
          : stream(model, message(model, [{ type: 'text', text: 'summary' }]));
      },
    });
    await f.session.prompt(`one ${'history '.repeat(400)}`);
    await f.session.prompt(`two ${'history '.repeat(400)}`);

    await f.session.compact('retry capture');

    const compact = f.brain.providerRequests.rows('s1').filter((row) => row.kind === 'compaction');
    expect(compact).toHaveLength(2);
    expect(compact[0]).toMatchObject({ status: 'error' });
    expect(compact[1]).toMatchObject({ status: 'succeeded', retry_of: compact[0]?.request_id });
  });

  it('does not invent retry correlation while capture is disabled', async () => {
    const f = await fixture({ enabled: () => false, run: retryRun });

    await f.session.prompt('uncaptured retry');

    expect(f.brain.providerRequests.rows('s1')).toEqual([]);
  });

  it('does not let a disabled provider-internal retry overwrite the captured failed attempt', async () => {
    let enabled = true;
    const f = await fixture({
      enabled: () => enabled,
      firstStatus: 500,
      repeatPayload: async (request, model, payload) => {
        enabled = false;
        await request.onPayload?.({ ...payload, internal_retry: 1 }, model);
        await request.onResponse?.({ status: 500, headers: {} } as never, model);
        enabled = true;
        await request.onPayload?.({ ...payload, internal_retry: 2 }, model);
        await request.onResponse?.({ status: 200, headers: {} } as never, model);
      },
      run: async (model) => stream(model, message(model, [{ type: 'text', text: 'recovered internally' }])),
    });

    await f.session.prompt('internal retry');

    const rows = f.brain.providerRequests.rows('s1');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: 'error', http_status: 500, error_code: 'http_500' });
    expect(rows[1]).toMatchObject({ status: 'succeeded', retry_of: null });
  });

  it('associates an abort terminal with the exact captured attempt', async () => {
    const f = await fixture({
      run: async (model, _context, request) => {
        const out = createAssistantMessageEventStream();
        queueMicrotask(() => out.push({ type: 'start', partial: message(model, []) }));
        request.signal?.addEventListener('abort', () => {
          out.push({ type: 'error', reason: 'aborted', error: message(model, [], 'aborted', 'Request aborted') });
          out.end();
        }, { once: true });
        return out;
      },
    });

    const prompt = f.session.prompt('abort capture');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await f.session.abort();
    await prompt;

    const rows = f.brain.providerRequests.rows('s1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'error', turn_id: 'turn:1', retry_of: null, http_status: 200,
      error_code: 'aborted', error_message: 'Request aborted', total_tokens: 20,
    });
    expect(f.brain.providerRequests.reconstruct(rows[0]!.request_id)).toMatchObject({ transformed: true, model: 'chat-model' });
  });

  it('keeps overflow, recovery compaction, and replacement capture on their real attempts', async () => {
    let ordinary = 0;
    const f = await fixture({
      payload: (model, context, call) => ({
        model: model.id, instructions: context.systemPrompt, input: context.messages, attempt_marker: call,
        tools: [{ type: 'function', name: `attempt_${call}`, parameters: { type: 'object', properties: { call: { const: call } } } }],
      }),
      run: async (model, context) => {
        if (context.systemPrompt?.includes('context summarization assistant')) {
          return stream(model, message(model, [{ type: 'text', text: 'summary' }]));
        }
        ordinary += 1;
        if (ordinary === 1) return stream(model, message(model, [{ type: 'text', text: 'seed' }], 'stop', undefined));
        return ordinary === 2
          ? stream(model, message(model, [], 'error', 'prompt is too long: 213462 tokens > 2000 maximum'))
          : stream(model, message(model, [{ type: 'text', text: 'recovered' }]));
      },
    });
    await f.session.prompt(`seed ${'history '.repeat(400)}`);

    await f.session.prompt(`overflow ${'history '.repeat(800)}`);

    const rows = f.brain.providerRequests.rows('s1');
    expect(rows.map((row) => ({ kind: row.kind, status: row.status, turn: row.turn_id, retry: row.retry_of }))).toEqual([
      { kind: 'chat', status: 'succeeded', turn: 'turn:1', retry: null },
      { kind: 'chat', status: 'error', turn: 'turn:2', retry: null },
      { kind: 'compaction', status: 'succeeded', turn: 'compaction:1', retry: null },
      { kind: 'chat', status: 'succeeded', turn: 'turn:3', retry: null },
    ]);
    expect(rows[1]).toMatchObject({ error_code: 'error', http_status: 200 });
    const payloads = rows.map((row) => f.brain.providerRequests.reconstruct(row.request_id) as { attempt_marker: number; transformed: boolean; tools: { name: string; parameters: unknown }[] });
    expect(payloads.map((payload) => payload.attempt_marker)).toEqual([1, 2, 3, 4]);
    expect(payloads.map((payload) => payload.tools[0]?.name)).toEqual(['attempt_1', 'attempt_2', 'attempt_3', 'attempt_4']);
    expect(payloads.map((payload) => payload.transformed)).toEqual([true, true, undefined, true]);
  });

  it('turns a thrown provider call into a terminal error attempt instead of leaving it pending', async () => {
    const f = await fixture({
      run: async () => { throw new Error('socket exploded'); },
    });

    await f.session.prompt('throw');

    expect(f.brain.providerRequests.rows('s1')).toHaveLength(1);
    expect(f.brain.providerRequests.rows('s1')[0]).toMatchObject({ status: 'error', error_message: 'socket exploded' });
  });

  // The pause/park incident of 5. 9. 2026: an attempt opened before SIGTERM is closed as `interrupted`
  // while its stream is still open (the pause, or the boot pass after a crash). The old process may still
  // see that stream's response and terminal; the next process opens a fresh attempt in the same session.
  // Neither may log an ERROR or break capture — the old recorder just notes the late events.
  it('survives a pause closing its pending attempt: late response is a warning and the resumed session captures again', async () => {
    const log = captureLog();
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let pauseHit = false;
      const f = await fixture({
        run: async (model) => {
          const out = createAssistantMessageEventStream();
          void (async () => {
            out.push({ type: 'start', partial: message(model, []) });
            await gate;
            out.push({ type: 'done', reason: 'stop', message: message(model, [{ type: 'text', text: 'late answer' }]) });
            out.end();
          })();
          return out;
        },
        repeatPayload: async (request, model) => {
          // SIGTERM lands between the payload and the response: the pause closes the pending row, then
          // the still-open stream delivers a (second) response and its terminal to the OLD recorder.
          if (pauseHit) return;
          pauseHit = true;
          expect(f.brain.providerRequests.interruptPending({ errorCode: 'daemon_pause', errorMessage: 'paused' }, { sessionId: 's1' })).toHaveLength(1);
          await request.onResponse?.({ status: 200, headers: {} } as never, model);
        },
      });
      const prompt = f.session.prompt('park me');
      await new Promise((resolve) => setTimeout(resolve, 20));
      release();
      await prompt;

      const parked = f.brain.providerRequests.rows('s1');
      expect(parked).toHaveLength(1);
      expect(parked[0]).toMatchObject({ status: 'interrupted', error_code: 'daemon_pause', http_status: 200 });
      expect(log.lines.filter((line) => line.level === 'error')).toEqual([]);
      expect(log.lines.some((line) => line.level === 'warn' && /arrived after the attempt was closed as interrupted \(daemon_pause\)/.test(line.message))).toBe(true);

      // The next boot: nothing is left pending for the boot pass, and the resumed turn (a fresh recorder
      // on the same session id) captures a new attempt without tripping the one-pending rule.
      expect(f.brain.providerRequests.interruptPending({ errorCode: 'daemon_restart', errorMessage: 'restart' })).toEqual([]);
      const resumed = await fixture({
        brain: f.brain,
        run: async (model) => stream(model, message(model, [{ type: 'text', text: 'resumed answer' }])),
      });
      await resumed.session.prompt('continue');
      expect(f.brain.providerRequests.rows('s1').map((row) => row.status)).toEqual(['interrupted', 'succeeded']);
      expect(log.lines.filter((line) => line.level === 'error')).toEqual([]);
    } finally {
      log.stop();
    }
  });

  // The stale-pointer variant: the pending row is closed from outside and NO terminal event ever reaches the
  // recorder (the stream simply never ends), then the same session issues its next request. The old code
  // declared "request started before X terminated" and broke capture for the rest of the session.
  it('opens a fresh attempt when its active row was closed from outside without a terminal', async () => {
    const log = captureLog();
    try {
      const brain = new BrainStore(openDb(':memory:'));
      brain.createSession({ id: 's1', userId: 7, model: 'chat-model', provider: 'configured' });
      const recorder = new ProviderRequestRecorder({ store: brain.providerRequests, sessionId: 's1', configuredProvider: 'configured', enabled: () => true });
      const model = { id: 'chat-model', provider: 'wire', api: 'stub' } as Model<Api>;
      const runtime = recorder.wrapRuntime({
        streamSimple: (_model: Model<Api>, _context: Context, request?: SimpleStreamOptions) => {
          void request?.onPayload?.({ model: 'chat-model', messages: [] }, model);
          return createAssistantMessageEventStream(); // never ends: the process is about to exit
        },
      } as unknown as Parameters<ProviderRequestRecorder['wrapRuntime']>[0]);
      const context = { messages: [] } as unknown as Context;

      runtime.streamSimple(model, context, {});
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(brain.providerRequests.interruptPending({ errorCode: 'daemon_pause', errorMessage: 'paused' })).toHaveLength(1);
      runtime.streamSimple(model, context, {});
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(brain.providerRequests.rows('s1').map((row) => ({ status: row.status, code: row.error_code }))).toEqual([
        { status: 'interrupted', code: 'daemon_pause' },
        { status: 'pending', code: null },
      ]);
      expect(log.lines.filter((line) => line.level === 'error')).toEqual([]);
      expect(log.lines.some((line) => line.level === 'warn' && /was closed as interrupted \(daemon_pause\) before its stream ended/.test(line.message))).toBe(true);
    } finally {
      log.stop();
    }
  });

  // PI's split-turn compaction (the cut lands inside the newest turn) issues TWO sequential provider calls
  // between one compaction_start and its compaction_end: the history summary, then the turn-prefix
  // summary. Terminating compaction attempts only on compaction_end left the first call pending when the
  // second opened — the production "request started before … terminated" invariant, three times in a week.
  it('captures both calls of a split-turn compaction as separate succeeded attempts', async () => {
    const log = captureLog();
    try {
      const summaries: string[] = [];
      const f = await fixture({
        run: async (model, context, _request, call) => {
          if (context.systemPrompt?.includes('context summarization assistant')) {
            summaries.push(context.messages.map((m) => JSON.stringify(m.content)).join('').slice(0, 40));
            return stream(model, message(model, [{ type: 'text', text: `summary ${summaries.length}` }]));
          }
          // Turn 2 is a tool loop ending on an answer larger than the keep-recent budget (10 tokens), so
          // the cut lands on that final assistant message, inside the turn: a split turn.
          if (call === 2) return stream(model, message(model, [{ type: 'toolCall', id: 'probe-1', name: 'probe', arguments: {} }], 'toolUse'));
          return stream(model, message(model, [{ type: 'text', text: call === 3 ? 'done '.repeat(40) : 'ok' }]));
        },
      });
      await f.session.prompt(`one ${'history '.repeat(400)}`);
      await f.session.prompt(`two ${'history '.repeat(400)}`);

      const result = await f.session.compact('split capture');

      expect(summaries).toHaveLength(2);
      expect(result.summary).toContain('Turn Context (split turn)');
      const compact = f.brain.providerRequests.rows('s1').filter((row) => row.kind === 'compaction');
      expect(compact.map((row) => ({ status: row.status, turn: row.turn_id, retry: row.retry_of, tokens: row.total_tokens }))).toEqual([
        { status: 'succeeded', turn: 'compaction:1', retry: null, tokens: 20 },
        { status: 'succeeded', turn: 'compaction:1', retry: null, tokens: 20 },
      ]);
      expect(log.lines.filter((line) => line.level === 'error' || line.level === 'warn')).toEqual([]);
      // Capture is intact afterwards: the next turn is still recorded.
      await f.session.prompt('after');
      expect(f.brain.providerRequests.rows('s1').at(-1)).toMatchObject({ kind: 'chat', status: 'succeeded' });
    } finally {
      log.stop();
    }
  });

  it('stops new writes immediately when the runtime kill switch is off', async () => {
    let enabled = false;
    const f = await fixture({
      enabled: () => enabled,
      run: async (model) => stream(model, message(model, [{ type: 'text', text: 'answer' }])),
    });
    await f.session.prompt('not captured');
    enabled = true;
    await f.session.prompt('captured');

    expect(f.brain.providerRequests.rows('s1')).toHaveLength(1);
  });
});
