import { describe, expect, it } from 'vitest';
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
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
import { createCodexCompactionModelRoute } from '../../src/brain/session/codexCompaction.js';

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

function responseStream(model: Model<Api>, text: string, totalTokens: number, errorMessage?: string) {
  const stream = createAssistantMessageEventStream();
  const message = assistantMessage(
    model,
    errorMessage ? [] : [{ type: 'text', text }],
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

function appendToolHistory(sm: SessionManager, model: Model<Api>, suffix = 'one'): void {
  sm.appendMessage({ role: 'user', content: `inspect ${suffix}`, timestamp: Date.now() });
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
  const api = `elowen-test-compaction-${++apiSequence}` as Api;
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  registry.registerProvider(provider, {
    name: 'Compaction test provider', api, baseUrl: 'https://provider.example.test',
    apiKey: 'oauth-token', headers: { 'x-native-route': 'preserved' },
    streamSimple: (model, context, options) => {
      calls.push({ model, context, options });
      const summarizing = context.systemPrompt?.includes('context summarization assistant') === true;
      return responseStream(
        model,
        summarizing ? 'native PI summary' : 'chat answer',
        summarizing ? 10 : (o.autoUsage ?? 20),
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
    compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: o.keepRecentTokens ?? 4 },
  }, { projectTrusted: true });
  const cwd = process.cwd();
  const sessionManager = SessionManager.inMemory(cwd);
  appendToolHistory(sessionManager, selected);
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [...(route ? [route.extension] : []), observer],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd, sessionManager, settingsManager, modelRegistry: registry, model: selected,
    resourceLoader, noTools: 'all', thinkingLevel: 'high',
  });
  route?.install(session);
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
