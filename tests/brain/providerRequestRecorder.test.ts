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
import { ProviderRequestRecorder } from '../../src/brain/session/providerRequestRecorder.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { openDb } from '../../src/store/db.js';

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
  enabled?: () => boolean;
  firstStatus?: number;
  repeatPayload?: (request: SimpleStreamOptions, model: Model<Api>, payload: Record<string, unknown>) => Promise<void>;
  run: (model: Model<Api>, context: Context, request: SimpleStreamOptions, call: number) => ReturnType<typeof stream> | Promise<ReturnType<typeof stream>>;
}) {
  const db = openDb(':memory:');
  const brain = new BrainStore(db);
  brain.createSession({ id: 's1', userId: 7, model: 'chat-model', provider: 'configured' });
  const runtime = await inMemoryModelRuntime();
  const registry = new ModelRegistry(runtime);
  const api = `request-recorder-${Math.random()}` as Api;
  let call = 0;
  registry.registerProvider('wire', {
    name: 'Recorder provider', api, baseUrl: 'https://provider.invalid', apiKey: 'key',
    streamSimple: async (model, context, request = {}) => {
      call += 1;
      const initial = {
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
      id: 'chat-model', name: 'chat-model', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 2_000, maxTokens: 512,
    }],
  });
  const model = registry.find('wire', 'chat-model');
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
    extensionFactories: [transform],
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

  it('turns a thrown provider call into a terminal error attempt instead of leaving it pending', async () => {
    const f = await fixture({
      run: async () => { throw new Error('socket exploded'); },
    });

    await f.session.prompt('throw');

    expect(f.brain.providerRequests.rows('s1')).toHaveLength(1);
    expect(f.brain.providerRequests.rows('s1')[0]).toMatchObject({ status: 'error', error_message: 'socket exploded' });
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
