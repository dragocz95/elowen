import {
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
} from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { inMemoryModelRuntime } from '../../src/brain/providers.js';

/** A real `AgentSession` over a fake provider, capturing the payload each request actually sent.
 *
 *  It exists because the only other harness that reaches a real session — `providerRequestRecorder.test.ts`
 *  — keeps its fixture private and routes every payload through the store, which is more machinery than a
 *  payload assertion needs. What both share, and what makes them worth the setup, is that the captured
 *  value is the payload AFTER the whole extension chain: `request.onPayload()` returns whatever
 *  `before_provider_request` handlers produced, so a test sees exactly what would have gone on the wire.
 *
 *  PI ships `fauxProvider()` for fake responses and it is deliberately NOT used here. It registers fine
 *  (`ModelRegistry.registerProvider` takes a native Provider) and a `FauxResponseFactory` even receives the
 *  request `Context`, so branching on the prompt is expressible. Three things are not, and between them they
 *  rule it out for every provider fake in this suite except one:
 *
 *   - It calls `onResponse` but NEVER `onPayload`, so it can only show the pre-conversion `Context` — blind
 *     to `cache_control` and to every other egress transform this harness and `providerRequestRecorder`
 *     exist to observe.
 *   - Usage is not scriptable. `withUsageEstimate` overwrites whatever usage a scripted message carries with
 *     its own chars/4 estimate of the serialized context, so a test cannot state the token count that drives
 *     `shouldCompact` — which is the entire subject of the compaction and prefill-baseline tests.
 *   - `RegisterFauxProviderOptions` has no `baseUrl`, `apiKey` or `headers`, so the per-provider routing and
 *     header-propagation assertions in `compactionModelRoute` have nothing to assert against.
 *
 *  Only `malformedToolCallRecovery` could migrate, and one test is not worth a second idiom. Worth reaching
 *  for if we ever test DEFERRED/background responses, where faux's `pendingFetches` and `cancelDeferred`
 *  would be real work to hand-roll; its prompt-cache simulation is common-prefix over the serialized context,
 *  not real breakpoints, so it cannot check ours. */

/** pi-ai marks the last block of the payload's last message. Replicated verbatim so `cacheBreakpoints`
 *  sees the same shape it does in production; it abstains outright when no marker is present. */
const PI_CACHE_MARKER = { type: 'ephemeral', ttl: '1h' } as const;

interface WireBlock extends Record<string, unknown> {
  type: string;
  text: string;
}

interface WireMessage extends Record<string, unknown> {
  role: string;
  content: WireBlock[];
}

export interface WirePayload extends Record<string, unknown> {
  model: string;
  system: unknown;
  tools: unknown[];
  messages: WireMessage[];
}

function flatten(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    const value = (part as { text?: unknown } | null)?.text;
    if (typeof value === 'string') text += value;
  }
  return text;
}

/** Project PI's per-request `Context` into an Anthropic-shaped body. The projection is deliberately
 *  trivial and identical on every turn, so it cannot mask a prefix change: whatever differs between two
 *  captured payloads differs because the conversation differed. */
function anthropicBody(model: Model<Api>, context: Context, tools: readonly unknown[]): WirePayload {
  const messages: WireMessage[] = context.messages.map((message) => ({
    role: (message as { role?: string }).role ?? 'user',
    content: [{ type: 'text', text: flatten((message as { content?: unknown }).content) }],
  }));
  const last = messages[messages.length - 1];
  const lastBlock = last?.content[last.content.length - 1];
  if (lastBlock) lastBlock.cache_control = { ...PI_CACHE_MARKER };
  return {
    model: model.id,
    system: [{ type: 'text', text: context.systemPrompt ?? '' }],
    tools: [...tools],
    messages,
  };
}

export interface PayloadHarnessOptions {
  /** Extensions to install, in order — e.g. `installCacheBreakpoints`. */
  extensionFactories?: ((pi: ExtensionAPI) => void)[];
  /** Tool definitions advertised on every request. Constant by default, so `tools` stays byte-stable. */
  tools?: readonly unknown[];
  systemPrompt?: string;
  /** HTTP status handed to `after_provider_response`, per call (1-based). Defaults to 200. */
  statusFor?: (call: number) => number;
}

export interface PayloadHarness {
  session: AgentSession;
  settings: SettingsManager;
  /** Final, post-extension payloads in request order. */
  payloads: WirePayload[];
  /** Run one turn and return the payloads it produced. */
  prompt: (text: string) => Promise<WirePayload[]>;
}

export async function providerPayloadHarness(options: PayloadHarnessOptions = {}): Promise<PayloadHarness> {
  const runtime = await inMemoryModelRuntime();
  const registry = new ModelRegistry(runtime);
  // A per-harness api id keeps pi-ai's provider registry from colliding across test files in one process.
  const api = `payload-harness-${Math.random()}` as Api;
  const tools = options.tools ?? [{ type: 'function', name: 'probe', parameters: { type: 'object' } }];
  const payloads: WirePayload[] = [];
  let call = 0;

  registry.registerProvider('harness', {
    name: 'Payload harness', api, baseUrl: 'https://provider.invalid', apiKey: 'key',
    streamSimple: async (model, context, request = {}) => {
      call += 1;
      const body = anthropicBody(model, context, tools);
      // The RETURN value is the point: it is the payload after every `before_provider_request` handler.
      const sent = (await request.onPayload?.(body, model)) ?? body;
      payloads.push(sent as WirePayload);
      await request.onResponse?.({ status: options.statusFor?.(call) ?? 200, headers: {} } as never, model);
      const out = createAssistantMessageEventStream();
      const answer: AssistantMessage = {
        role: 'assistant', content: [{ type: 'text', text: 'ok' }],
        api: model.api, provider: model.provider, model: model.id,
        usage: {
          input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop', timestamp: Date.now(),
      };
      queueMicrotask(() => {
        out.push({ type: 'start', partial: { ...answer, content: [] } });
        out.push({ type: 'done', reason: 'stop', message: answer });
      });
      return out;
    },
    models: [{
      id: 'harness-model', name: 'harness-model', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 512,
    }],
  });

  const model = registry.find('harness', 'harness-model');
  if (!model) throw new Error('harness model missing');

  // Compaction is switched off outright: a harness turn must never rewrite history behind the assertion.
  const settings = SettingsManager.inMemory({
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
    compaction: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 1_000 },
  }, { projectTrusted: true });
  const cwd = process.cwd();
  const loader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager: settings,
    systemPrompt: options.systemPrompt ?? 'harness system prompt',
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [...(options.extensionFactories ?? [])],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd, sessionManager: SessionManager.inMemory(cwd), settingsManager: settings,
    modelRuntime: runtime, model, resourceLoader: loader,
    customTools: [defineTool({
      name: 'probe', label: 'Probe', description: 'Unused; keeps the tool block non-empty',
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: 'text', text: 'tool result' }], details: {} }),
    })],
    tools: ['probe'], noTools: 'builtin',
  });

  return {
    session,
    settings,
    payloads,
    prompt: async (text: string) => {
      const before = payloads.length;
      await session.prompt(text);
      return payloads.slice(before);
    },
  };
}
