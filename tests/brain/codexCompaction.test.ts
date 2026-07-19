import { describe, expect, it, vi } from 'vitest';
import {
  calculateContextTokens,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
  defineTool,
} from '@earendil-works/pi-coding-agent';
import { inMemoryModelRuntime } from '../../src/brain/providers.js';
import { Type } from 'typebox';
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { createCodexCompactionModelRoute } from '../../src/brain/session/codexCompaction.js';
import { installTurnBoundaryAutoCompaction } from '../../src/brain/session/turnBoundaryCompaction.js';

interface ProviderCall {
  model: Model<Api>;
  context: Context;
  options?: SimpleStreamOptions;
}

interface FixtureOptions {
  provider?: string;
  selectedId?: string;
  fallbackId?: string;
  summaryError?: string;
  autoUsage?: number;
  keepRecentTokens?: number;
  multiTurn?: boolean;
  reserveTokens?: number;
  toolResultText?: string;
  historyPadding?: string;
  queueDuringTool?: 'steer' | 'followUp';
  queuedText?: string;
}

let apiSequence = 0;

const usage = (totalTokens: number) => ({
  input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function assistantMessage(
  model: Model<Api>,
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'] = 'stop',
  totalTokens = 20,
  errorMessage?: string,
): AssistantMessage {
  return {
    role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
    usage: usage(totalTokens), stopReason, ...(errorMessage ? { errorMessage } : {}), timestamp: Date.now(),
  };
}

function responseStream(model: Model<Api>, response: string | AssistantMessage['content'], totalTokens: number, errorMessage?: string) {
  const stream = createAssistantMessageEventStream();
  const message = assistantMessage(
    model,
    errorMessage ? [] : typeof response === 'string' ? [{ type: 'text', text: response }] : response,
    errorMessage ? 'error' : 'stop',
    totalTokens,
    errorMessage,
  );
  queueMicrotask(() => {
    // Mirror the provider event contract so AgentSession persists both sides of a normal turn before
    // its post-run auto-compaction check.
    stream.push({ type: 'start', partial: assistantMessage(model, [], 'stop', 0) });
    if (errorMessage) stream.push({ type: 'error', reason: 'error', error: message });
    else stream.push({ type: 'done', reason: 'stop', message });
  });
  return stream;
}

function appendToolHistory(sm: SessionManager, model: Model<Api>, suffix = 'one', padding = ''): void {
  sm.appendMessage({ role: 'user', content: `inspect ${suffix}${padding ? `\n${padding}` : ''}`, timestamp: Date.now() });
  sm.appendMessage(assistantMessage(model, [
    { type: 'toolCall', id: `read-${suffix}`, name: 'read', arguments: { path: `/read-${suffix}.ts` } },
    { type: 'toolCall', id: `edit-${suffix}`, name: 'edit', arguments: { path: `/edit-${suffix}.ts` } },
  ], 'toolUse'));
  sm.appendMessage({
    role: 'toolResult', toolCallId: `read-${suffix}`, toolName: 'read',
    content: [{ type: 'text', text: 'source' }], isError: false, timestamp: Date.now(),
  });
  sm.appendMessage({
    role: 'toolResult', toolCallId: `edit-${suffix}`, toolName: 'edit',
    content: [{ type: 'text', text: 'done' }], isError: false, timestamp: Date.now(),
  });
  sm.appendMessage(assistantMessage(model, [{ type: 'text', text: `finished ${suffix}` }]));
  sm.appendMessage({ role: 'user', content: `keep recent ${suffix}`, timestamp: Date.now() });
  sm.appendMessage(assistantMessage(model, [{ type: 'text', text: `recent ${suffix}` }]));
}

async function fixture(o: FixtureOptions = {}): Promise<{
  session: AgentSession;
  sessionManager: SessionManager;
  calls: ProviderCall[];
  compactions: { fromExtension: boolean; reason: string }[];
  selected: Model<Api>;
}> {
  const provider = o.provider ?? 'openai-codex';
  const selectedId = o.selectedId ?? 'gpt-5.6-luna';
  const fallbackId = o.fallbackId;
  const calls: ProviderCall[] = [];
  let ordinaryCalls = 0;
  let activeSession: AgentSession | undefined;
  const api = `elowen-test-compaction-${++apiSequence}` as Api;
  const runtime = await inMemoryModelRuntime();
  const registry = new ModelRegistry(runtime);
  registry.registerProvider(provider, {
    name: 'Compaction test provider', api, baseUrl: 'https://provider.example.test',
    apiKey: 'oauth-token', headers: { 'x-native-route': 'preserved' },
    streamSimple: (model, context, options) => {
      calls.push({ model, context, options });
      const summarizing = context.systemPrompt?.includes('context summarization assistant') === true;
      ordinaryCalls += summarizing ? 0 : 1;
      if (o.multiTurn && !summarizing && ordinaryCalls === 1) {
        return responseStream(model, [{
          type: 'toolCall', id: 'probe-1', name: 'context_probe', arguments: {},
        }], o.autoUsage ?? 700);
      }
      return responseStream(
        model,
        summarizing ? 'native PI summary' : 'chat answer',
        summarizing ? 10 : (o.multiTurn ? 20 : (o.autoUsage ?? 20)),
        summarizing ? o.summaryError : undefined,
      );
    },
    models: [...new Set([selectedId, ...(fallbackId ? [fallbackId] : [])])].map((id) => ({
      id, name: id, reasoning: true, input: ['text'] as ('text' | 'image')[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000, maxTokens: 512,
    })),
  });
  const selected = registry.find(provider, selectedId)!;
  const fallback = fallbackId ? registry.find(provider, fallbackId) : undefined;
  const route = createCodexCompactionModelRoute(fallback);
  const compactions: { fromExtension: boolean; reason: string }[] = [];
  const observer = (pi: ExtensionAPI) => {
    pi.on('session_compact', (event) => {
      compactions.push({ fromExtension: event.fromExtension, reason: event.reason });
    });
  };
  const settingsManager = SettingsManager.inMemory({
    defaultThinkingLevel: 'high',
    httpIdleTimeoutMs: 4_321,
    retry: { provider: { maxRetries: 2, maxRetryDelayMs: 99 } },
    // Keep the final user/assistant pair and summarize the preceding complete tool turn. A larger
    // budget would intentionally split that tool turn and exercise PI's separate prefix summary.
    compaction: { enabled: true, reserveTokens: o.reserveTokens ?? 500, keepRecentTokens: o.keepRecentTokens ?? 4 },
  }, { projectTrusted: true });
  const cwd = process.cwd();
  const sessionManager = SessionManager.inMemory(cwd);
  appendToolHistory(sessionManager, selected, 'one', o.historyPadding);
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [...(route ? [route.extension] : []), observer],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd, sessionManager, settingsManager, modelRuntime: runtime, model: selected,
    resourceLoader,
    customTools: [defineTool({
      name: 'context_probe', label: 'Context probe', description: 'Continue one deterministic tool turn',
      parameters: Type.Object({}),
      execute: async () => {
        if (o.queueDuringTool && activeSession) {
          await activeSession[o.queueDuringTool](o.queuedText ?? 'queued while the tool was running');
        }
        return { content: [{ type: 'text', text: o.toolResultText ?? 'probe complete' }], details: {} };
      },
    })],
    tools: ['context_probe'], noTools: 'builtin', thinkingLevel: 'high',
  });
  route?.install(session);
  installTurnBoundaryAutoCompaction(session, sessionManager, true);
  activeSession = session;
  return { session, sessionManager, calls, compactions, selected };
}

describe('Codex compaction model routing', () => {
  it('keeps repeated manual compaction PI-native and preserves native stream options + file details', async () => {
    const f = await fixture({ fallbackId: 'gpt-5.5' });

    const first = await f.session.compact('preserve exact decisions');

    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.model.id).toBe('gpt-5.5');
    expect(f.calls[0]?.options).toMatchObject({
      apiKey: 'oauth-token', reasoning: 'high', timeoutMs: 4_321,
      maxRetries: 2, maxRetryDelayMs: 99,
      headers: expect.objectContaining({ 'x-native-route': 'preserved' }),
    });
    expect(f.calls[0]?.options?.signal).toBeInstanceOf(AbortSignal);
    expect(f.calls[0]?.context.systemPrompt).toContain('context summarization assistant');
    expect(f.session.model).toBe(f.selected);
    expect(f.compactions).toEqual([{ fromExtension: false, reason: 'manual' }]);
    expect(first.details).toEqual({ readFiles: ['/read-one.ts'], modifiedFiles: ['/edit-one.ts'] });
    const firstEntry = f.sessionManager.getBranch().at(-1);
    expect(firstEntry).toMatchObject({
      type: 'compaction', details: first.details,
    });
    expect(firstEntry && 'fromHook' in firstEntry ? firstEntry.fromHook : undefined).not.toBe(true);

    appendToolHistory(f.sessionManager, f.selected, 'two');
    f.session.agent.state.messages = f.sessionManager.buildSessionContext().messages;
    const second = await f.session.compact();

    expect(f.calls).toHaveLength(2);
    expect(f.calls.map((call) => call.model.id)).toEqual(['gpt-5.5', 'gpt-5.5']);
    expect(f.compactions).toEqual([
      { fromExtension: false, reason: 'manual' },
      { fromExtension: false, reason: 'manual' },
    ]);
    expect(second.details).toEqual({
      readFiles: ['/read-one.ts', '/read-two.ts'],
      modifiedFiles: ['/edit-one.ts', '/edit-two.ts'],
    });
  });

  it('routes only the auto-compaction request while normal chat stays on the selected model', async () => {
    const f = await fixture({ fallbackId: 'gpt-5.5', autoUsage: 700, keepRecentTokens: 30 });

    await f.session.prompt('trigger threshold compaction');

    expect(f.calls.map((call) => call.model.id)).toEqual(['gpt-5.6-luna', 'gpt-5.5']);
    expect(f.compactions).toEqual([{ fromExtension: false, reason: 'threshold' }]);
    expect(f.session.model).toBe(f.selected);
  });

  it('compacts at the safe turn boundary before a tool loop starts its next provider call', async () => {
    const f = await fixture({
      fallbackId: 'gpt-5.5', autoUsage: 750, reserveTokens: 200, keepRecentTokens: 150, multiTurn: true,
      // The assistant response itself is below the 800-token threshold. Only the completed tool result
      // pushes the real next-request context above it — the boundary check must account for that tail.
      toolResultText: 'large diagnostic result '.repeat(24),
      historyPadding: 'older context detail '.repeat(100),
    });

    await f.session.prompt('compact before the second model step');

    expect(f.session.messages.at(-1)).toMatchObject({ role: 'assistant', stopReason: 'stop' });
    expect(JSON.stringify(f.session.messages.findLast((message) => message.role === 'toolResult')?.content).length).toBeGreaterThan(300);
    expect(f.calls.map((call) => [
      call.model.id,
      call.context.systemPrompt?.includes('context summarization assistant') === true ? 'summary' : 'chat',
    ])).toEqual([
      ['gpt-5.6-luna', 'chat'], // assistant requests a tool below the configured 80% threshold
      ['gpt-5.5', 'summary'], // trailing tool output crosses it; PI summarizes older history
      ['gpt-5.5', 'summary'], // PI's native split-turn prefix summary stays on the same fallback route
      ['gpt-5.6-luna', 'chat'], // the next agent step sees the compacted context on the selected model
    ]);
    expect(f.compactions).toEqual([{ fromExtension: false, reason: 'threshold' }]);
    expect(f.calls.at(-1)?.context.messages.some((message) => message.role === 'user'
      && JSON.stringify(message.content).includes('conversation history before this point was compacted'))).toBe(true);
  });

  it.each(['steer', 'followUp'] as const)(
    'accounts for a queued %s before the provider request that first receives it',
    async (queueDuringTool) => {
      const queuedText = `critical queued context ${'x'.repeat(760)}`;
      const f = await fixture({
        fallbackId: 'gpt-5.5', autoUsage: 700, reserveTokens: 200, keepRecentTokens: 30,
        multiTurn: true, queueDuringTool, queuedText,
        historyPadding: 'older context detail '.repeat(100),
      });

      await f.session.prompt('queue a large instruction while the tool runs');

      const summaryIndex = f.calls.findIndex((call) =>
        call.context.systemPrompt?.includes('context summarization assistant') === true);
      const queuedRequestIndex = f.calls.findIndex((call) =>
        call.context.messages.some((message) => JSON.stringify(message.content).includes(queuedText)));
      expect(queuedRequestIndex).toBeGreaterThan(-1);
      expect(summaryIndex).toBeGreaterThan(-1);
      expect(summaryIndex).toBeLessThan(queuedRequestIndex);
    },
  );

  it('includes queued context when the current assistant reports zero usage', async () => {
    const queuedText = `zero-usage queued context ${'z'.repeat(3_600)}`;
    const f = await fixture({
      fallbackId: 'gpt-5.5', autoUsage: 0, reserveTokens: 200, keepRecentTokens: 30,
      multiTurn: true, queueDuringTool: 'steer', queuedText,
      historyPadding: 'older context detail '.repeat(100),
    });

    await f.session.prompt('queue after a zero-usage tool response');

    const summaryIndex = f.calls.findIndex((call) =>
      call.context.systemPrompt?.includes('context summarization assistant') === true);
    const queuedRequestIndex = f.calls.findIndex((call) =>
      call.context.messages.some((message) => JSON.stringify(message.content).includes(queuedText)));
    expect(summaryIndex).toBeGreaterThan(-1);
    expect(summaryIndex).toBeLessThan(queuedRequestIndex);
  });

  it('includes image attachments from the authoritative queue mirror in the boundary budget', async () => {
    const checkCompaction = vi.fn(async () => false);
    const session = {
      _checkCompaction: checkCompaction,
      abortCompaction: vi.fn(),
      agent: {
        state: { messages: [], model: {}, thinkingLevel: 'high' },
        prepareNextTurnWithContext: undefined as unknown,
      },
    };
    const manager = { getBranch: () => [] };
    installTurnBoundaryAutoCompaction(session as never, manager as never, true, () => [{
      text: 'queued screenshot',
      images: [{ type: 'image', data: 'BASE64', mimeType: 'image/png' }],
    }]);

    await (session.agent.prepareNextTurnWithContext as unknown as (turn: unknown) => Promise<unknown>)({
      message: assistantMessage({} as never, [], 'toolUse', 700), context: { messages: [] }, toolResults: [],
    });

    const checked = checkCompaction.mock.calls[0]?.[0] as AssistantMessage;
    // PI estimates an image as 4,800 chars / 4 = 1,200 tokens, plus its text.
    expect(calculateContextTokens(checked.usage)).toBeGreaterThanOrEqual(1_900);
  });

  it('does not reuse stale pre-compaction usage for a later zero-usage response', async () => {
    const checkCompaction = vi.fn(async () => false);
    const session = {
      _checkCompaction: checkCompaction,
      abortCompaction: vi.fn(),
      agent: {
        state: { messages: [], model: {}, thinkingLevel: 'high' },
        prepareNextTurnWithContext: undefined as unknown,
      },
    };
    const manager = { getBranch: () => [{
      type: 'compaction', id: 'compact-1', timestamp: new Date(1_000).toISOString(),
    }] };
    installTurnBoundaryAutoCompaction(session as never, manager as never, true);
    const staleAssistant = {
      ...assistantMessage({} as never, [], 'stop', 9_000), timestamp: 100,
    };
    const currentAssistant = {
      ...assistantMessage({} as never, [], 'toolUse', 0), timestamp: 2_000,
    };

    await (session.agent.prepareNextTurnWithContext as unknown as (turn: unknown) => Promise<unknown>)({
      message: currentAssistant,
      context: { messages: [
        { role: 'compactionSummary', summary: 'older context', timestamp: 1_000 },
        staleAssistant,
        currentAssistant,
      ] },
      toolResults: [],
    });

    const checked = checkCompaction.mock.calls[0]?.[0] as AssistantMessage;
    expect(calculateContextTokens(checked.usage)).toBeLessThan(1_000);
  });

  it('links the agent abort signal to PI\'s independent auto-compaction controller', async () => {
    const controller = new AbortController();
    let release!: () => void;
    const compacting = new Promise<void>((resolve) => { release = resolve; });
    const session = {
      _checkCompaction: vi.fn(async () => compacting.then(() => false)),
      abortCompaction: vi.fn(() => release()),
      agent: {
        state: { messages: [], model: {}, thinkingLevel: 'high' },
        prepareNextTurnWithContext: undefined as unknown,
      },
    };
    const manager = { getBranch: () => [] };
    expect(installTurnBoundaryAutoCompaction(session as never, manager as never, true)).toBe(true);

    const pending = (session.agent.prepareNextTurnWithContext as unknown as (
      turn: unknown, signal: AbortSignal,
    ) => Promise<unknown>)({
      message: assistantMessage({} as never, [], 'toolUse', 750), context: {}, toolResults: [],
    }, controller.signal);
    await Promise.resolve();
    controller.abort();
    await pending;

    expect(session.abortCompaction).toHaveBeenCalledOnce();
  });

  it('replays an early abort when PI creates its compaction controller after async auth', async () => {
    const controller = new AbortController();
    let releaseAuth!: () => void;
    const auth = new Promise<void>((resolve) => { releaseAuth = resolve; });
    let controllerReady = false;
    let summaryAborted = false;
    const listeners = new Set<(event: { type: string }) => void>();
    const session = {
      _checkCompaction: vi.fn(async () => {
        await auth;
        for (const listener of listeners) listener({ type: 'compaction_start' });
        controllerReady = true;
        await Promise.resolve();
        return false;
      }),
      abortCompaction: vi.fn(() => {
        if (controllerReady) summaryAborted = true;
      }),
      subscribe: vi.fn((listener: (event: { type: string }) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      agent: {
        state: { messages: [], model: {}, thinkingLevel: 'high' },
        prepareNextTurnWithContext: undefined as unknown,
      },
    };
    const manager = { getBranch: () => [] };
    expect(installTurnBoundaryAutoCompaction(session as never, manager as never, true)).toBe(true);

    const pending = (session.agent.prepareNextTurnWithContext as unknown as (
      turn: unknown, signal: AbortSignal,
    ) => Promise<unknown>)({
      message: assistantMessage({} as never, [], 'toolUse', 750), context: {}, toolResults: [],
    }, controller.signal);
    await Promise.resolve();
    controller.abort();
    releaseAuth();
    await pending;

    expect(summaryAborted).toBe(true);
    expect(listeners).toHaveLength(0);
  });

  it.each(['quota exceeded', 'authentication failed'])('surfaces %s after one native summary request', async (error) => {
    const f = await fixture({ fallbackId: 'gpt-5.5', summaryError: error });

    await expect(f.session.compact()).rejects.toThrow(`Summarization failed: ${error}`);

    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.model.id).toBe('gpt-5.5');
    expect(f.compactions).toEqual([]);
  });

  it('uses the selected model and its native error when no configured fallback exists', async () => {
    const f = await fixture({ summaryError: 'Model not found internal-preview-alias' });

    await expect(f.session.compact()).rejects.toThrow('Summarization failed: Model not found internal-preview-alias');

    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.model).toBe(f.selected);
    expect(f.compactions).toEqual([]);
  });

  it('does not route compaction for a custom OpenAI-compatible proxy', async () => {
    const f = await fixture({ provider: 'elowen-proxy', selectedId: 'preview-chat-model' });

    await f.session.compact();

    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.model).toBe(f.selected);
    expect(f.compactions).toEqual([{ fromExtension: false, reason: 'manual' }]);
  });

  it('binds the fallback independently for respawned Luna and switched Sol sessions', async () => {
    const luna = await fixture({ selectedId: 'gpt-5.6-luna', fallbackId: 'gpt-5.5' });
    const sol = await fixture({ selectedId: 'gpt-5.6-sol', fallbackId: 'gpt-5.5' });

    await luna.session.compact();
    await sol.session.compact();

    expect(luna.session.model?.id).toBe('gpt-5.6-luna');
    expect(sol.session.model?.id).toBe('gpt-5.6-sol');
    expect(luna.calls.map((call) => call.model.id)).toEqual(['gpt-5.5']);
    expect(sol.calls.map((call) => call.model.id)).toEqual(['gpt-5.5']);
  });
});
