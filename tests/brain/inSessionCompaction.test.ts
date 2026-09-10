import { describe, expect, it } from 'vitest';
import {
  convertToLlm,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
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
import { Type } from 'typebox';
import { inMemoryModelRuntime } from '../../src/brain/providers.js';
import {
  createInSessionCompaction,
  inSessionCompactionApplies,
  summarizationInstruction,
} from '../../src/brain/session/inSessionCompaction.js';
import { ProviderRequestRecorder } from '../../src/brain/session/providerRequestRecorder.js';
import { setLogSink, type LogLevel } from '../../src/shared/logger.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { openDb } from '../../src/store/db.js';

const SYSTEM_PROMPT = 'in-session compaction test persona';
/** The two halves of PI's summarization prompt that must reach the model through the appended message. */
const PI_INSTRUCTION = 'Create a structured context checkpoint summary';
const PI_GUARD = 'Do NOT continue the conversation';
/** The opening line of PI's turn-prefix prompt, which a split turn adds as a SECOND request. */
const PI_TURN_PREFIX = 'This is the PREFIX of a turn that was too large to keep.';

interface ProviderCall {
  model: Model<Api>;
  context: Context;
  options?: SimpleStreamOptions;
}

interface FixtureOptions {
  /** How the provider answers the in-session summary request. */
  summary?: 'text' | 'toolCall' | 'empty' | 'error';
  recordRequests?: boolean;
  /** Register a cancelling `session_before_compact` handler ahead of the summarizer, the way the factory
   *  registers the compaction circuit breaker ahead of it. */
  cancelBefore?: boolean;
  /** Append a turn big enough that the cut point falls INSIDE it, which is what makes PI split the turn
   *  and issue a second, turn-prefix summarization request. */
  splitTurn?: boolean;
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

function responseStream(
  model: Model<Api>,
  content: AssistantMessage['content'],
  totalTokens: number,
  errorMessage?: string,
  usageOverride?: AssistantMessage['usage'],
) {
  const stream = createAssistantMessageEventStream();
  const message = assistantMessage(model, errorMessage ? [] : content, errorMessage ? 'error' : 'stop', totalTokens, errorMessage);
  if (usageOverride) message.usage = usageOverride;
  queueMicrotask(() => {
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

/** A turn whose PREFIX is far larger than `keepRecentTokens`, so PI's cut point lands on the big
 *  assistant message inside it rather than on a turn boundary: `isSplitTurn`, and a second summarization
 *  request for the prefix of that turn. */
function appendSplitTurn(sm: SessionManager, model: Model<Api>): void {
  sm.appendMessage({ role: 'user', content: 'analyze the failing deploy log', timestamp: Date.now() });
  sm.appendMessage(assistantMessage(model, [{ type: 'text', text: 'log analysis '.repeat(400) }]));
  sm.appendMessage(assistantMessage(model, [{ type: 'text', text: 'done' }]));
}

/** The request classifier the fake provider uses, and the same one the assertions read: an in-session
 *  summary is the request that keeps the SESSION's system prompt and carries PI's instruction last. */
function isInSessionSummary(context: Context): boolean {
  const last = context.messages.at(-1);
  return context.systemPrompt?.startsWith(SYSTEM_PROMPT) === true
    && last?.role === 'user'
    && JSON.stringify(last.content).includes(PI_INSTRUCTION);
}

function isStandaloneSummary(context: Context): boolean {
  return context.systemPrompt?.includes('context summarization assistant') === true;
}

function captureWarnings(): { lines: string[]; stop: () => void } {
  const lines: string[] = [];
  setLogSink({
    push: (entry: { scope?: string; level: LogLevel; message: string }) => {
      if (entry.scope === 'in-session-compaction') lines.push(`${entry.level}: ${entry.message}`);
    },
  });
  return { lines, stop: () => setLogSink(undefined) };
}

async function fixture(o: FixtureOptions = {}): Promise<{
  session: AgentSession;
  sessionManager: SessionManager;
  calls: ProviderCall[];
  compactions: { fromExtension: boolean; reason: string }[];
  model: Model<Api>;
  brain?: BrainStore;
}> {
  const calls: ProviderCall[] = [];
  const api = `elowen-test-in-session-${++apiSequence}` as Api;
  const runtime = await inMemoryModelRuntime();
  const registry = new ModelRegistry(runtime);
  registry.registerProvider('elowen-warm', {
    name: 'Warm prefix provider', api, baseUrl: 'https://provider.example.test', apiKey: 'session-key',
    streamSimple: async (model, context, options) => {
      calls.push({ model, context, options });
      // The seam the request recorder observes; a real provider adapter always reports its final body.
      await options?.onPayload?.({ model: model.id, system: context.systemPrompt, messages: context.messages }, model);
      await options?.onResponse?.({ status: 200, headers: {} } as never, model);
      if (isStandaloneSummary(context)) return responseStream(model, [{ type: 'text', text: 'standalone PI summary' }], 10);
      if (!isInSessionSummary(context)) return responseStream(model, [{ type: 'text', text: 'chat answer' }], 20);
      switch (o.summary) {
      case 'toolCall':
        return responseStream(model, [{ type: 'toolCall', id: 'probe-1', name: 'context_probe', arguments: {} }], 10);
      case 'empty':
        return responseStream(model, [{ type: 'text', text: '   ' }], 10);
      case 'error':
        return responseStream(model, [], 10, 'provider refused the summary request');
      default:
        // Distinct input/cache halves so the audit log's usage line can be asserted exactly.
        return responseStream(model, [{ type: 'text', text: 'in-session summary' }], 10, undefined, {
          input: 700, output: 42, cacheRead: 500, cacheWrite: 100, totalTokens: 742,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        });
      }
    },
    models: [{
      id: 'warm-model', name: 'warm-model', reasoning: true, input: ['text'] as ('text' | 'image')[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000, maxTokens: 512,
    }],
  });
  const model = registry.find('elowen-warm', 'warm-model')!;
  const inSession = createInSessionCompaction(o.recordRequests ? { sessionId: 's1' } : {});
  const compactions: { fromExtension: boolean; reason: string }[] = [];
  const observer = (pi: ExtensionAPI) => {
    pi.on('session_compact', (event) => {
      compactions.push({ fromExtension: event.fromExtension, reason: event.reason });
    });
  };
  const settingsManager = SettingsManager.inMemory({
    defaultThinkingLevel: 'high',
    compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 4 },
  }, { projectTrusted: true });
  const cwd = process.cwd();
  const sessionManager = SessionManager.inMemory(cwd);
  appendToolHistory(sessionManager, model, 'one');
  if (o.splitTurn) appendSplitTurn(sessionManager, model);
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager, systemPrompt: SYSTEM_PROMPT,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [
      ...(o.cancelBefore ? [(pi: ExtensionAPI) => { pi.on('session_before_compact', () => ({ cancel: true })); }] : []),
      inSession.extension,
      observer,
    ],
  });
  await resourceLoader.reload();
  let brain: BrainStore | undefined;
  let modelRuntime = runtime;
  let recorder: ProviderRequestRecorder | undefined;
  if (o.recordRequests) {
    brain = new BrainStore(openDb(':memory:'));
    brain.createSession({ id: 's1', userId: 7, model: 'warm-model', provider: 'elowen-warm' });
    recorder = new ProviderRequestRecorder({
      store: brain.providerRequests, sessionId: 's1', configuredProvider: 'elowen-warm', enabled: () => true,
    });
    modelRuntime = recorder.wrapRuntime(runtime);
  }
  const { session } = await createAgentSession({
    cwd, sessionManager, settingsManager, modelRuntime, model, resourceLoader,
    customTools: [defineTool({
      name: 'context_probe', label: 'Context probe', description: 'A tool the session carries',
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: 'text', text: 'probe complete' }], details: {} }),
    })],
    tools: ['context_probe'], noTools: 'builtin', thinkingLevel: 'high',
  });
  inSession.install(session);
  if (recorder) session.subscribe(recorder.observe);
  return { session, sessionManager, calls, compactions, model, ...(brain ? { brain } : {}) };
}

describe('In-session compaction', () => {
  it('summarizes on the live prefix plus one appended user message and lets PI persist the result', async () => {
    const f = await fixture();
    const before = [...f.session.agent.state.messages];

    const result = await f.session.compact();

    expect(f.calls).toHaveLength(1);
    const call = f.calls[0]!;
    // The session's own prefix: same system prompt, same tools, same converted history, in order.
    expect(call.context.systemPrompt).toBe(f.session.agent.state.systemPrompt);
    expect(call.context.tools?.map((tool) => tool.name)).toEqual(['context_probe']);
    expect(call.context.messages.slice(0, -1)).toEqual(convertToLlm(before));
    // …and exactly ONE extra message, carrying PI's own summarization prompt without the conversation
    // PI would otherwise re-serialize into it.
    const appended = call.context.messages.at(-1)!;
    expect(appended.role).toBe('user');
    const text = JSON.stringify(appended.content);
    expect(text).toContain(PI_INSTRUCTION);
    expect(text).toContain(PI_GUARD);
    expect(text).not.toContain('<conversation>');
    // The session's own cache retention, not PI's one-off "none", and the session's routing id.
    expect(call.options?.cacheRetention).toBeUndefined();
    expect(call.options?.sessionId).toBe(f.session.agent.sessionId);
    expect(call.options?.reasoning).toBe('high');
    // PI persisted a compaction it did not generate itself.
    expect(f.compactions).toEqual([{ fromExtension: true, reason: 'manual' }]);
    expect(result.summary).toContain('in-session summary');
    expect(result.details).toEqual({ readFiles: ['/read-one.ts'], modifiedFiles: ['/edit-one.ts'] });
  });

  it('summarizes a split turn\'s prefix on PI\'s own context instead of the whole conversation again', async () => {
    const f = await fixture({ splitTurn: true });

    const result = await f.session.compact();

    // A split turn is TWO summarization requests: the history, then the prefix of the turn being split.
    expect(f.calls).toHaveLength(2);
    const [history, prefix] = f.calls as [ProviderCall, ProviderCall];
    // The history question is the one that pays off on the session's own warm prefix.
    expect(isInSessionSummary(history.context)).toBe(true);
    // The prefix question is about the split turn ALONE, so it goes out as PI built it: PI's
    // summarization system prompt and its one serialized message. Answering it with the live context
    // would summarize the whole conversation a second time, under a heading that claims to describe
    // one turn.
    expect(isStandaloneSummary(prefix.context)).toBe(true);
    expect(prefix.context.messages).toHaveLength(1);
    const prefixText = JSON.stringify(prefix.context.messages);
    expect(prefixText).toContain(PI_TURN_PREFIX);
    expect(prefixText).toContain('analyze the failing deploy log');
    expect(prefixText).not.toContain('inspect one');
    expect(prefix.context.tools).toBeUndefined();
    // PI's own one-off retention for a request that shares no prefix, and the auth this module resolves
    // for every request it sends.
    expect(prefix.options?.cacheRetention).toBe('none');
    expect(prefix.options?.apiKey).toBe(history.options?.apiKey);
    expect(result.summary).toContain('Turn Context (split turn)');
  });

  it('leaves the session history untouched and appends nothing that could carry a new cache breakpoint', async () => {
    const f = await fixture();
    const historyBefore = f.sessionManager.getBranch().length;

    await f.session.compact();

    expect(f.calls).toHaveLength(1);
    expect(isInSessionSummary(f.calls[0]!.context)).toBe(true);
    const branch = f.sessionManager.getBranch();
    // One new entry only, and it is the compaction itself — the summary turn never entered the session.
    expect(branch).toHaveLength(historyBefore + 1);
    expect(branch.at(-1)?.type).toBe('compaction');
    expect(JSON.stringify(branch)).not.toContain(PI_INSTRUCTION);
    expect(JSON.stringify(f.session.messages)).not.toContain(PI_INSTRUCTION);
    // The instruction is the request's LAST message and a user message, which is exactly where pi-ai's
    // single moving cache marker already sits on every chat request: the mark moves onto it rather than
    // being added beside the four Anthropic allows.
    const sent = f.calls[0]!.context.messages;
    expect(sent.at(-1)?.role).toBe('user');
    expect(sent.filter((message) => JSON.stringify(message.content).includes(PI_INSTRUCTION))).toHaveLength(1);
  });

  it.each([
    ['toolCall', 'called a tool'],
    ['empty', 'no summary text'],
    ['error', 'provider refused the summary request'],
  ] as const)('falls back to PI\'s standalone summary when the in-session request answers with %s', async (summary, warning) => {
    const log = captureWarnings();
    try {
      const f = await fixture({ summary });

      const result = await f.session.compact();

      expect(f.calls).toHaveLength(2);
      expect(isInSessionSummary(f.calls[0]!.context)).toBe(true);
      // PI's untouched path: its own summarization system prompt, its own single serialized message.
      expect(isStandaloneSummary(f.calls[1]!.context)).toBe(true);
      expect(JSON.stringify(f.calls[1]!.context.messages)).toContain('<conversation>');
      expect(f.calls[1]!.options?.cacheRetention).toBe('none');
      expect(result.summary).toContain('standalone PI summary');
      expect(f.compactions).toEqual([{ fromExtension: false, reason: 'manual' }]);
      expect(log.lines.filter((line) => line.startsWith('warn'))).toHaveLength(1);
      expect(log.lines[0]).toContain(warning);
      // The audit line is a success record only: a fallthrough must not log one.
      expect(log.lines.some((line) => line.startsWith('info'))).toBe(false);
    } finally {
      log.stop();
    }
  });

  it('records the in-session request as a compaction provider request', async () => {
    const f = await fixture({ recordRequests: true });

    await f.session.compact();

    expect(isInSessionSummary(f.calls[0]!.context)).toBe(true);
    const rows = f.brain!.providerRequests.rows('s1');
    // One row, not two: the in-session request is the whole compaction, recorded under the same kind the
    // standalone summary has always used.
    expect(rows.map((row) => ({ kind: row.kind, status: row.status, turn: row.turn_id }))).toEqual([
      { kind: 'compaction', status: 'succeeded', turn: 'compaction:1' },
    ]);
  });

  it('logs one INFO line with the session, model and request usage after a successful in-session summary', async () => {
    const log = captureWarnings();
    try {
      const f = await fixture({ recordRequests: true });

      await f.session.compact();

      expect(isInSessionSummary(f.calls[0]!.context)).toBe(true);
      const info = log.lines.filter((line) => line.startsWith('info'));
      expect(info).toHaveLength(1);
      expect(info[0]).toContain('s1');
      expect(info[0]).toContain('warm-model');
      expect(info[0]).toContain('input 700, cacheRead 500, cacheWrite 100, output 42');
    } finally {
      log.stop();
    }
  });

  it('issues no request at all when an earlier handler cancels the compaction', async () => {
    const f = await fixture({ cancelBefore: true });

    await expect(f.session.compact()).rejects.toThrow('Compaction cancelled');

    // The compaction circuit breaker cancels exactly this way, and it is registered ahead of the
    // summarizer for this reason: a summary issued before the cancel would be paid for and discarded on
    // every turn of a session whose compaction can no longer succeed.
    expect(f.calls).toEqual([]);
  });

  it('leaves compaction to PI when the summary would not run on the session\'s own prefix', () => {
    const distinct = { id: 'cheap-model', provider: 'elowen-cheap' } as Model<Api>;

    expect(inSessionCompactionApplies({})).toBe(true);
    // A distinct compaction model has no cache entry of this conversation to read.
    expect(inSessionCompactionApplies({ compactionFallbackModel: distinct })).toBe(false);
  });

  it('refuses a summarization prompt whose shape it does not recognise', () => {
    const wrapped = (text: string): Context => ({
      systemPrompt: 'You are a context summarization assistant.',
      messages: [{ role: 'user', content: [{ type: 'text', text }], timestamp: 0 }],
    });

    expect(summarizationInstruction(wrapped(`<conversation>\nolder work\n</conversation>\n\n${PI_INSTRUCTION}`)))
      .toBe(`You are a context summarization assistant.\n\n${PI_INSTRUCTION}`);
    // A previous summary is model-written text and can quote the closing tag; the real end of the
    // conversation is the one before `<previous-summary>`, not the last one in the string.
    const quoted = '<conversation>\nolder work\n</conversation>\n\n'
      + '<previous-summary>\nthe module strips \n</conversation>\n\n from the prompt\n</previous-summary>\n\n'
      + PI_INSTRUCTION;
    expect(summarizationInstruction(wrapped(quoted))).toContain('<previous-summary>\nthe module strips');
    expect(() => summarizationInstruction(wrapped(`${PI_INSTRUCTION} with no conversation block`))).toThrow();
    expect(() => summarizationInstruction(wrapped('<conversation>\nonly a conversation\n</conversation>\n\n'))).toThrow();
    expect(() => summarizationInstruction({ messages: [] })).toThrow();
  });
});
