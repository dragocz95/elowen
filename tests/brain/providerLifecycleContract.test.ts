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
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { inMemoryModelRuntime } from '../../src/brain/providers.js';

const usage = (totalTokens: number) => ({
  input: totalTokens, output: 1, cacheRead: 2, cacheWrite: 3, totalTokens: totalTokens + 6,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function message(
  model: Model<Api>,
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'] = 'stop',
  errorMessage?: string,
  totalTokens = 10,
): AssistantMessage {
  return {
    role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
    usage: usage(totalTokens), stopReason, ...(errorMessage ? { errorMessage } : {}), timestamp: Date.now(),
  };
}

function stream(model: Model<Api>, answer: AssistantMessage): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  queueMicrotask(() => {
    out.push({ type: 'start', partial: message(model, []) });
    if (answer.stopReason === 'error') out.push({ type: 'error', reason: 'error', error: answer });
    else out.push({ type: 'done', reason: answer.stopReason === 'toolUse' ? 'toolUse' : 'stop', message: answer });
  });
  return out;
}

interface ProviderCall {
  payload: Record<string, unknown>;
}

async function lifecycleFixture(run: (
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
  call: number,
) => Promise<AssistantMessageEventStream> | AssistantMessageEventStream) {
  const runtime = await inMemoryModelRuntime();
  const registry = new ModelRegistry(runtime);
  const api = `provider-lifecycle-${Math.random()}` as Api;
  const calls: ProviderCall[] = [];
  let call = 0;
  registry.registerProvider('contract', {
    name: 'Contract provider', api, baseUrl: 'https://provider.invalid', apiKey: 'test',
    streamSimple: async (model, context, options = {}) => {
      call += 1;
      const initial = {
        model: model.id,
        system: context.systemPrompt,
        messages: context.messages,
        tools: [{ name: call === 1 ? 'initial_tool' : 'dynamic_tool', input_schema: { type: 'object' } }],
        marker: 'provider-built',
      };
      const payload = (await options.onPayload?.(initial, model) ?? initial) as Record<string, unknown>;
      calls.push({ payload });
      return run(model, context, options, call);
    },
    models: [{
      id: 'contract-model', name: 'contract-model', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 2_000, maxTokens: 512,
    }],
  });
  const model = registry.find('contract', 'contract-model');
  if (!model) throw new Error('contract model missing');
  const events: string[] = [];
  const transforms = (pi: ExtensionAPI) => {
    pi.on('before_provider_request', (event) => {
      events.push('before:first');
      return { ...(event.payload as object), transformed: 'first' };
    });
    pi.on('before_provider_request', (event) => {
      events.push(`before:last:${String((event.payload as { transformed?: unknown }).transformed)}`);
      return { ...(event.payload as object), transformed: 'final' };
    });
    pi.on('after_provider_response', (event) => { events.push(`after:${event.status}`); });
  };
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
    compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 10 },
  }, { projectTrusted: true });
  const cwd = process.cwd();
  const sessionManager = SessionManager.inMemory(cwd);
  const loader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager, systemPrompt: 'contract system',
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [transforms],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd, sessionManager, settingsManager, modelRuntime: runtime, model, resourceLoader: loader,
    customTools: [defineTool({
      name: 'probe', label: 'Probe', description: 'Continue the deterministic tool loop',
      parameters: Type.Object({}), execute: async () => ({ content: [{ type: 'text', text: 'tool result' }], details: {} }),
    })],
    tools: ['probe'], noTools: 'builtin',
  });
  session.subscribe((event) => {
    if (event.type === 'message_end' && event.message.role === 'assistant') events.push(`message_end:${event.message.stopReason}`);
    else if (event.type === 'agent_end') events.push(`agent_end:${event.willRetry}`);
    else if (event.type === 'auto_retry_start') events.push('auto_retry_start');
    else if (event.type === 'auto_retry_end') events.push(`auto_retry_end:${event.success}`);
    else if (event.type === 'compaction_start') events.push(`compaction_start:${event.reason}`);
    else if (event.type === 'compaction_end') events.push(`compaction_end:${event.reason}:${!!event.result}`);
  });
  return { session, calls, events, model };
}

function index(events: string[], value: string): number {
  const found = events.indexOf(value);
  expect(found, `${value} missing from ${events.join(', ')}`).toBeGreaterThanOrEqual(0);
  return found;
}

describe('PI provider lifecycle contract', () => {
  it('runs request transforms serially and emits response then message_end for every tool-loop attempt', async () => {
    const f = await lifecycleFixture(async (model, _context, options, call) => {
      await options.onResponse?.({ status: 200, headers: {} } as never, model);
      return call === 1
        ? stream(model, message(model, [{ type: 'toolCall', id: 'probe-1', name: 'probe', arguments: {} }], 'toolUse'))
        : stream(model, message(model, [{ type: 'text', text: 'done' }]));
    });

    await f.session.prompt('run the probe');

    expect(f.calls).toHaveLength(2);
    expect(f.calls.map((call) => call.payload.transformed)).toEqual(['final', 'final']);
    expect((f.calls[0]?.payload.tools as { name: string }[])[0]?.name).toBe('initial_tool');
    expect((f.calls[1]?.payload.tools as { name: string }[])[0]?.name).toBe('dynamic_tool');
    const firstBefore = index(f.events, 'before:last:first');
    const firstAfter = index(f.events, 'after:200');
    const firstEnd = index(f.events, 'message_end:toolUse');
    expect(firstBefore).toBeLessThan(firstAfter);
    expect(firstAfter).toBeLessThan(firstEnd);
    const secondBefore = f.events.lastIndexOf('before:last:first');
    const secondAfter = f.events.lastIndexOf('after:200');
    const secondEnd = index(f.events, 'message_end:stop');
    expect(firstEnd).toBeLessThan(secondBefore);
    expect(secondBefore).toBeLessThan(secondAfter);
    expect(secondAfter).toBeLessThan(secondEnd);
    expect(secondEnd).toBeLessThan(index(f.events, 'agent_end:false'));
  });

  it('closes the failed assistant attempt before auto_retry_start and opens the replacement afterwards', async () => {
    const f = await lifecycleFixture(async (model, _context, options, call) => {
      await options.onResponse?.({ status: call === 1 ? 429 : 200, headers: {} } as never, model);
      return call === 1
        ? stream(model, message(model, [], 'error', 'rate limit exceeded'))
        : stream(model, message(model, [{ type: 'text', text: 'recovered' }]));
    });

    await f.session.prompt('retry once');

    expect(f.calls).toHaveLength(2);
    const failedEnd = index(f.events, 'message_end:error');
    const retryStart = index(f.events, 'auto_retry_start');
    const replacementBefore = f.events.lastIndexOf('before:last:first');
    const recoveredEnd = index(f.events, 'message_end:stop');
    expect(index(f.events, 'after:429')).toBeLessThan(failedEnd);
    expect(failedEnd).toBeLessThan(index(f.events, 'agent_end:true'));
    expect(failedEnd).toBeLessThan(retryStart);
    expect(retryStart).toBeLessThan(replacementBefore);
    expect(replacementBefore).toBeLessThan(index(f.events, 'after:200'));
    expect(index(f.events, 'after:200')).toBeLessThan(recoveredEnd);
    expect(recoveredEnd).toBeLessThan(index(f.events, 'auto_retry_end:true'));
  });

  it('emits compaction scope but bypasses provider request/response extension hooks', async () => {
    const f = await lifecycleFixture(async (model, context, options) => {
      await options.onResponse?.({ status: 200, headers: {} } as never, model);
      const compacting = context.systemPrompt?.includes('context summarization assistant') === true;
      return stream(model, message(model, [{ type: 'text', text: compacting ? 'summary' : 'answer' }]));
    });
    await f.session.prompt(`one ${'history '.repeat(400)}`);
    await f.session.prompt(`two ${'history '.repeat(400)}`);
    f.events.length = 0;
    f.calls.length = 0;

    await f.session.compact('manual contract');

    expect(f.calls).toHaveLength(1);
    expect(f.events).toEqual(['compaction_start:manual', 'compaction_end:manual:true']);
  });

  it('runs threshold compaction only after the triggering agent_end settles', async () => {
    let ordinary = 0;
    const f = await lifecycleFixture(async (model, context, options) => {
      await options.onResponse?.({ status: 200, headers: {} } as never, model);
      const compacting = context.systemPrompt?.includes('context summarization assistant') === true;
      if (compacting) return stream(model, message(model, [{ type: 'text', text: 'summary' }]));
      ordinary += 1;
      return stream(model, message(model, [{ type: 'text', text: 'answer' }], 'stop', undefined, ordinary === 1 ? 1_000 : 1_800));
    });
    await f.session.prompt(`seed ${'history '.repeat(400)}`);
    f.events.length = 0;

    await f.session.prompt(`large ${'history '.repeat(1_200)}`);

    const agentEnd = index(f.events, 'agent_end:false');
    const compactStart = index(f.events, 'compaction_start:threshold');
    expect(agentEnd).toBeLessThan(compactStart);
    expect(compactStart).toBeLessThan(index(f.events, 'compaction_end:threshold:true'));
  });

  it('emits overflow error, compaction, and replacement request in a serial order', async () => {
    let ordinary = 0;
    const f = await lifecycleFixture(async (model, context, options) => {
      await options.onResponse?.({ status: 200, headers: {} } as never, model);
      const compacting = context.systemPrompt?.includes('context summarization assistant') === true;
      if (compacting) return stream(model, message(model, [{ type: 'text', text: 'summary' }]));
      ordinary += 1;
      if (ordinary === 1) return stream(model, message(model, [{ type: 'text', text: 'seed answer' }], 'stop', undefined, 1_000));
      return ordinary === 2
        ? stream(model, message(model, [], 'error', 'prompt is too long: 213462 tokens > 2000 maximum'))
        : stream(model, message(model, [{ type: 'text', text: 'recovered' }]));
    });
    await f.session.prompt(`seed ${'history '.repeat(400)}`);
    f.events.length = 0;

    await f.session.prompt(`overflow ${'history '.repeat(800)}`);

    const failed = index(f.events, 'message_end:error');
    const compactStart = index(f.events, 'compaction_start:overflow');
    const compactEnd = index(f.events, 'compaction_end:overflow:true');
    const recovered = f.events.lastIndexOf('message_end:stop');
    expect(failed).toBeLessThan(compactStart);
    expect(compactStart).toBeLessThan(compactEnd);
    expect(compactEnd).toBeLessThan(recovered);
  });

  it('emits an aborted message terminal before agent_end', async () => {
    const f = await lifecycleFixture(async (model, _context, options) => {
      const out = createAssistantMessageEventStream();
      queueMicrotask(() => out.push({ type: 'start', partial: message(model, []) }));
      options.signal?.addEventListener('abort', () => {
        const aborted = message(model, [], 'aborted', 'Request aborted');
        out.push({ type: 'error', reason: 'aborted', error: aborted });
        out.end();
      }, { once: true });
      return out;
    });

    const prompt = f.session.prompt('abort');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await f.session.abort();
    await prompt;

    expect(index(f.events, 'message_end:aborted')).toBeLessThan(index(f.events, 'agent_end:false'));
  });

  it('turns a thrown provider call into an assistant message_end error before agent_end', async () => {
    const f = await lifecycleFixture(async (_model, _context, _options) => {
      throw new Error('socket exploded');
    });

    await f.session.prompt('throw');

    expect(index(f.events, 'before:last:first')).toBeLessThan(index(f.events, 'message_end:error'));
    expect(index(f.events, 'message_end:error')).toBeLessThan(index(f.events, 'agent_end:false'));
    expect(f.events.some((event) => event.startsWith('after:'))).toBe(false);
  });
});
