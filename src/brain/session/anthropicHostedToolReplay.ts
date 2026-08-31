import { isDeepStrictEqual } from 'node:util';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { Api, AssistantMessage, Message, Model } from '@earendil-works/pi-ai';
import type { AgentSession, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { logger } from '../../shared/logger.js';

const log = logger('anthropic-hosted-replay');
const META_KEY = 'anthropicHostedToolReplay';
const REPLAY_VERSION = 1;
const SERVER_BLOCK_TYPES = new Set(['server_tool_use', 'tool_search_tool_result']);
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

export interface AnthropicHostedReplayMetadata {
  v: 1;
  /** Exact assistant content returned by Anthropic, including server-owned search blocks. */
  content: JsonObject[];
}

interface AnthropicHostedUnsafeMetadata {
  v: 1;
  /** Hosted content occurred, but the complete provider-owned assistant content was not safely captured. */
  unsafe: true;
}

interface AssistantWithReplay extends AssistantMessage {
  [META_KEY]?: AnthropicHostedReplayMetadata | AnthropicHostedUnsafeMetadata;
}

function record(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

// Keep this byte-for-byte equivalent to pi-ai's sanitize-unicode helper: matching is against the wire
// payload AFTER pi converts its internal assistant message, not against the unprojected stored text.
function sanitizeSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

const TOOL_SEARCH_NAMES = new Set(['tool_search_tool_bm25', 'tool_search_tool_regex']);

function hasCompleteToolSearchPairs(content: readonly JsonObject[]): boolean {
  const uses = new Map<string, number>();
  const results = new Map<string, number>();
  for (const block of content) {
    if (block.type === 'server_tool_use' && TOOL_SEARCH_NAMES.has(String(block.name))) {
      if (typeof block.id !== 'string') return false;
      uses.set(block.id, (uses.get(block.id) ?? 0) + 1);
    } else if (block.type === 'tool_search_tool_result') {
      if (typeof block.tool_use_id !== 'string') return false;
      results.set(block.tool_use_id, (results.get(block.tool_use_id) ?? 0) + 1);
    }
  }
  if (uses.size === 0 && results.size === 0) return true;
  if (uses.size !== results.size) return false;
  return [...uses].every(([id, count]) => count === 1 && results.get(id) === 1);
}

interface CaptureOutcome {
  metadata?: AnthropicHostedReplayMetadata;
  /** Hosted content started on the wire but could not be captured as one complete assistant response. */
  unsafeHostedContent: boolean;
}

class AnthropicSseCapture {
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private readonly blocks = new Map<number, { block: JsonObject; partialJson: string }>();
  private readonly stopped = new Set<number>();
  private messageStopped = false;
  private sawHostedContent = false;
  private abandoned = false;

  /** Capturing is BEST-EFFORT and must never fail the turn it is watching.
   *
   *  Everything here observes a stream the model's answer is riding on. A syntactically complete response
   *  can still be unsafe to replay: Anthropic accepts a hosted search while producing the answer, but rejects
   *  that assistant message on the next request unless every built-in tool-search call has its matching result.
   *  Such a response survives without replay metadata; malformed or truncated hosted content remains fail-closed. */
  feed(chunk: Uint8Array): void {
    try {
      this.buffer += this.decoder.decode(chunk, { stream: true });
      this.drain(false);
    } catch (error) {
      this.abandon(error);
    }
  }

  finish(): CaptureOutcome {
    try {
      this.buffer += this.decoder.decode();
      this.drain(true);
      if (!this.messageStopped) this.abandon('stream ended before message_stop');
      const indexes = [...this.blocks.keys()].sort((a, b) => a - b);
      if (!this.abandoned
        && (indexes.length === 0 || indexes.some((index, position) => index !== position || !this.stopped.has(index)))) {
        this.abandon('response contained incomplete content blocks');
      }
      if (this.abandoned) return { unsafeHostedContent: this.sawHostedContent };
      if (!this.sawHostedContent) return { unsafeHostedContent: false };
      const content = indexes.map((index) => clone(this.blocks.get(index)!.block));
      if (!hasCompleteToolSearchPairs(content)) {
        log.warn('hosted-search replay not captured, continuing without it: response contained an incomplete search pair');
        return { unsafeHostedContent: false };
      }
      return { metadata: { v: REPLAY_VERSION, content }, unsafeHostedContent: false };
    } catch (error) {
      this.abandon(error);
      return { unsafeHostedContent: this.sawHostedContent };
    }
  }

  /** Give up on replay metadata for good and say why once. Later frames are observed only for hosted starts. */
  private abandon(reason: unknown): undefined {
    if (!this.abandoned) {
      this.abandoned = true;
      const detail = reason instanceof Error ? reason.message : String(reason);
      log.warn(`hosted-search replay not captured, continuing without it: ${detail}`);
    }
    return undefined;
  }

  private drain(final: boolean): void {
    while (true) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (!match) break;
      const frame = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.consumeFrame(frame);
    }
    if (this.buffer.length > MAX_FRAME_BYTES) throw new Error('Anthropic SSE frame exceeded replay capture limit');
    if (final && this.buffer.trim()) throw new Error('Anthropic SSE ended inside a frame');
    if (final) this.buffer = '';
  }

  private consumeFrame(frame: string): void {
    const data = frame.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) return;
    let event: JsonObject | undefined;
    try { event = record(JSON.parse(data)); }
    catch (error) {
      if (this.abandoned) return;
      throw error;
    }
    if (!event) {
      if (this.abandoned) return;
      throw new Error('Anthropic SSE event was not an object');
    }
    const startedContent = event.type === 'content_block_start' ? record(event.content_block) : undefined;
    if (startedContent && SERVER_BLOCK_TYPES.has(String(startedContent.type))) this.sawHostedContent = true;
    // Once syntax/lifecycle safety is lost, metadata is irrecoverable, but keep parsing later complete frames
    // solely to learn whether hosted content occurred and the next provider boundary must be blocked.
    if (this.abandoned) return;
    if (event.type === 'message_stop') {
      if (this.messageStopped) throw new Error('Anthropic SSE contained duplicate message_stop');
      this.messageStopped = true;
      return;
    }
    if (this.messageStopped && String(event.type).startsWith('content_block_')) {
      throw new Error('Anthropic SSE contained content after message_stop');
    }
    const contentEvent = event.type === 'content_block_start'
      || event.type === 'content_block_delta'
      || event.type === 'content_block_stop';
    const index = typeof event.index === 'number' && Number.isInteger(event.index) && event.index >= 0
      ? event.index
      : undefined;
    if (contentEvent && index === undefined) throw new Error('Anthropic SSE content event had no valid index');
    if (index === undefined) return;

    if (event.type === 'content_block_start') {
      const content = startedContent;
      if (!content || this.blocks.has(index)) throw new Error('Anthropic SSE contained an invalid content block start');
      this.blocks.set(index, { block: clone(content), partialJson: '' });
      return;
    }
    if (event.type === 'content_block_delta') {
      const current = this.blocks.get(index);
      const delta = record(event.delta);
      if (!current || !delta || this.stopped.has(index)) throw new Error('Anthropic SSE delta referenced an inactive content block');
      if (delta.type === 'text_delta' && current.block.type === 'text' && typeof delta.text === 'string') {
        current.block.text = String(current.block.text ?? '') + delta.text;
      } else if (delta.type === 'thinking_delta' && current.block.type === 'thinking' && typeof delta.thinking === 'string') {
        current.block.thinking = String(current.block.thinking ?? '') + delta.thinking;
      } else if (delta.type === 'signature_delta' && current.block.type === 'thinking' && typeof delta.signature === 'string') {
        current.block.signature = String(current.block.signature ?? '') + delta.signature;
      } else if (delta.type === 'citations_delta' && current.block.type === 'text' && record(delta.citation)) {
        const citations = Array.isArray(current.block.citations) ? current.block.citations : [];
        current.block.citations = [...citations, clone(delta.citation)];
      } else if (delta.type === 'input_json_delta'
        && (current.block.type === 'tool_use' || current.block.type === 'server_tool_use')
        && typeof delta.partial_json === 'string') {
        current.partialJson += delta.partial_json;
      } else {
        throw new Error(`unsupported Anthropic replay delta ${String(delta.type)} for ${String(current.block.type)}`);
      }
      return;
    }
    if (event.type === 'content_block_stop') {
      const current = this.blocks.get(index);
      if (!current || this.stopped.has(index)) throw new Error('Anthropic SSE stop referenced an inactive content block');
      if (current.partialJson) current.block.input = JSON.parse(current.partialJson);
      this.stopped.add(index);
    }
  }
}

/** Parse one complete response fixture. Production uses the same state machine incrementally. */
export function captureAnthropicHostedReplay(sse: string): AnthropicHostedReplayMetadata | undefined {
  const capture = new AnthropicSseCapture();
  capture.feed(new TextEncoder().encode(sse));
  return capture.finish().metadata;
}

function replayMetadata(message: unknown): AnthropicHostedReplayMetadata | undefined {
  const meta = record(record(message)?.[META_KEY]);
  if (meta?.v !== REPLAY_VERSION || !Array.isArray(meta.content)) return undefined;
  const content = meta.content.map(record);
  if (content.some((block) => !block)
    || !content.some((block) => SERVER_BLOCK_TYPES.has(String(block?.type)))
    || !hasCompleteToolSearchPairs(content as JsonObject[])) return undefined;
  return { v: REPLAY_VERSION, content: content as JsonObject[] };
}

function hasUnsafeReplayMetadata(message: unknown): boolean {
  const meta = record(record(message)?.[META_KEY]);
  return meta?.v === REPLAY_VERSION && meta.unsafe === true;
}

function normalizedKnownContent(content: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const raw of content) {
    const block = record(raw);
    if (!block || typeof block.type !== 'string' || SERVER_BLOCK_TYPES.has(block.type)) continue;
    if (block.type === 'text') {
      const text = typeof block.text === 'string' ? sanitizeSurrogates(block.text) : '';
      if (text.trim()) out.push({ type: 'text', text });
    } else if (block.type === 'thinking') {
      out.push({
        type: 'thinking',
        thinking: sanitizeSurrogates(typeof block.thinking === 'string' ? block.thinking : ''),
        signature: block.signature ?? block.thinkingSignature,
      });
    } else if (block.type === 'redacted_thinking') {
      out.push({ type: 'redacted_thinking', data: block.data ?? block.thinkingSignature });
    } else if (block.type === 'tool_use' || block.type === 'toolCall') {
      out.push({
        type: 'tool_use', id: block.id,
        // OAuth conversion changes only the name; id + input are the stable response/request identity.
        input: block.input ?? block.arguments ?? {},
      });
    }
  }
  return out;
}

function replayEntries(contextMessages: readonly unknown[]): AnthropicHostedReplayMetadata[] {
  return contextMessages.flatMap((message) => {
    const meta = replayMetadata(message);
    return meta ? [meta] : [];
  });
}

function matchingAssistantIndex(messages: readonly unknown[], meta: AnthropicHostedReplayMetadata, claimed: Set<number>): number {
  const expected = normalizedKnownContent(meta.content);
  return messages.findIndex((message, index) => {
    if (claimed.has(index)) return false;
    const object = record(message);
    return object?.role === 'assistant' && Array.isArray(object.content)
      && isDeepStrictEqual(normalizedKnownContent(object.content), expected);
  });
}

/** Restore the COMPLETE raw assistant content after the hosted projector but before cache monitoring and
 * breakpoints. Rebuilding only the two omitted blocks is insufficient: Anthropic's signed-thinking rule is
 * explicitly verbatim and pi also filters whitespace-only text during conversion. */
export function restoreAnthropicHostedReplay(
  payload: unknown,
  contextMessages: readonly unknown[],
  expectedModelId: string,
): unknown | undefined {
  const object = record(payload);
  if (!object || object.model !== expectedModelId || !Array.isArray(object.messages)) return undefined;
  const entries = replayEntries(contextMessages);
  if (entries.length === 0) return undefined;

  const messages = object.messages as unknown[];
  const nextMessages = [...messages];
  const claimed = new Set<number>();
  let changed = false;
  for (const meta of entries) {
    const index = matchingAssistantIndex(messages, meta, claimed);
    if (index < 0) continue;
    const candidate = record(messages[index]);
    if (!candidate || !Array.isArray(candidate.content)) continue;
    if (isDeepStrictEqual(candidate.content, meta.content)) { claimed.add(index); continue; }
    nextMessages[index] = { ...candidate, content: clone(meta.content) };
    claimed.add(index);
    changed = true;
  }
  return changed ? { ...object, messages: nextMessages } : undefined;
}

export function verifyAnthropicHostedReplay(
  payload: unknown,
  contextMessages: readonly unknown[],
  expectedModelId: string,
): boolean {
  const object = record(payload);
  const entries = replayEntries(contextMessages);
  if (entries.length === 0) return true;
  if (!object || object.model !== expectedModelId || !Array.isArray(object.messages)) return false;
  const claimed = new Set<number>();
  for (const meta of entries) {
    const index = matchingAssistantIndex(object.messages, meta, claimed);
    if (index < 0) return false;
    const candidate = record(object.messages[index]);
    if (!candidate || !Array.isArray(candidate.content) || !isDeepStrictEqual(candidate.content, meta.content)) return false;
    claimed.add(index);
  }
  return true;
}

function requestBody(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body === 'string') return JSON.parse(body);
  if (body instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(body));
  return undefined;
}

interface CaptureHandle {
  result: Promise<CaptureOutcome>;
  cancel(reason: unknown): Promise<void>;
}

function tapAnthropicResponse(response: Response): { response: Response; capture?: CaptureHandle } {
  if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    return { response };
  }
  const capture = new AnthropicSseCapture();
  const reader = response.body.getReader();
  let settled = false;
  let resolveResult!: (value: CaptureOutcome) => void;
  const result = new Promise<CaptureOutcome>((resolve) => { resolveResult = resolve; });
  const settleResolve = (value: CaptureOutcome): void => {
    if (settled) return;
    settled = true;
    resolveResult(value);
  };
  const cancel = async (reason: unknown): Promise<void> => {
    // Consumers may cancel after message_stop instead of reading the transport to EOF. Finalize what was
    // actually observed: a complete response remains replayable, while an early hosted cancellation becomes
    // an unsafe outcome. Capture cancellation must never turn an already-finished provider answer into error.
    settleResolve(capture.finish());
    try { await reader.cancel(reason); } catch { /* the provider stream is already failing */ }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          settleResolve(capture.finish());
          controller.close();
          return;
        }
        // `feed` swallows its own failures by design, so reaching the catch below means the PROVIDER
        // stream broke — the only kind of failure that may legitimately take the consumer's stream down.
        capture.feed(value);
        controller.enqueue(value);
      } catch (error) {
        // The provider transport still fails for its consumer, but capture remains best-effort. Resolve its
        // own outcome so an earlier failed attempt cannot poison a later successful provider retry.
        settleResolve(capture.finish());
        controller.error(error);
      }
    },
    cancel,
  });
  const tapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  return { response: tapped, capture: { result, cancel } };
}

export interface AnthropicHostedToolReplay {
  extension: (pi: ExtensionAPI) => void;
  install: (session: AgentSession) => void;
}

function replayError(model: Model<Api>, error: unknown, base?: AssistantMessage): AssistantMessage {
  const message = error instanceof Error ? error.message : 'unknown replay failure';
  return {
    ...(base ?? {
      role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: Date.now(),
    }),
    content: [],
    stopReason: 'error',
    errorMessage: `Anthropic hosted tool-search replay failed: ${message}`,
  };
}

/** Elowen-side compatibility shim for pi-ai 0.84.2. Remove it once pi-ai preserves Anthropic
 * server_tool_use/tool_search_tool_result blocks in AssistantMessage and convertMessages itself. */
export function createAnthropicHostedToolReplay(
  expected: Pick<Model<Api>, 'id' | 'api' | 'provider'>,
): AnthropicHostedToolReplay {
  const expectedModelId = expected.id;
  let currentContext: readonly unknown[] = [];
  let unsafeHostedReplay = false;
  const compactionSignals = new WeakSet<AbortSignal>();
  const installed = new WeakSet<AgentSession['agent']>();

  return {
    extension(pi) {
      // PI's own compaction is the recovery path for an unsafe durable turn: its standalone summary request
      // does not replay that turn as signed assistant content, and a successful rewrite removes the marker.
      pi.on('session_before_compact', (event) => { compactionSignals.add(event.signal); });
      pi.on('before_provider_request', (event) =>
        restoreAnthropicHostedReplay(event.payload, currentContext, expectedModelId));
    },

    install(session) {
      const agent = session.agent;
      if (installed.has(agent)) return;
      installed.add(agent);
      session.subscribe?.((event) => {
        if (event.type === 'compaction_end' && !event.aborted && event.result) unsafeHostedReplay = false;
      });
      const nativeStream = agent.streamFunction;
      agent.streamFunction = (model: Model<Api>, context, options) => {
        if (model.id !== expected.id || model.api !== expected.api || model.provider !== expected.provider) {
          // The extension is session-global but compaction can route one call through another provider with
          // the same model id/API. Never let that request inherit replay state from the preceding chat call.
          currentContext = [];
          return nativeStream(model, context, options);
        }
        currentContext = context.messages;
        const recoveryRequest = options?.signal !== undefined && compactionSignals.has(options.signal);
        const captures: CaptureHandle[] = [];
        const baseFetch = options?.fetch ?? globalThis.fetch;
        const fetchWithCapture: typeof globalThis.fetch = async (input, init) => {
          const body = requestBody(init);
          if (!recoveryRequest && (unsafeHostedReplay || currentContext.some(hasUnsafeReplayMetadata))) {
            throw new Error('previous Anthropic hosted-search response could not be captured safely');
          }
          if (!verifyAnthropicHostedReplay(body, currentContext, expectedModelId)) {
            throw new Error('final Anthropic request is missing persisted hosted-search response blocks');
          }
          const tapped = tapAnthropicResponse(await baseFetch(input, init));
          if (tapped.capture) captures.push(tapped.capture);
          return tapped.response;
        };

        const out = createAssistantMessageEventStream();
        void (async () => {
          const inner = await nativeStream(model, context, { ...options, fetch: fetchWithCapture });
          for await (const event of inner) {
            if (event.type === 'done') {
              // A provider retry can leave an earlier capture failed or incomplete. The assistant event was
              // produced by the LAST successful response, so only that response may author its replay data.
              const latest = captures.at(-1);
              const outcome = latest ? await latest.result : undefined;
              if (outcome?.metadata) (event.message as AssistantWithReplay)[META_KEY] = outcome.metadata;
              // The provider answer is already complete and must survive. If its final response contained
              // unsafe hosted content, persist a fail-closed marker; compaction above is the explicit escape.
              if (outcome?.unsafeHostedContent) {
                unsafeHostedReplay = true;
                (event.message as AssistantWithReplay)[META_KEY] = { v: REPLAY_VERSION, unsafe: true };
              }
            } else if (event.type === 'error' && captures.length > 0) {
              await Promise.all(captures.map((capture) => capture.cancel(event.error.errorMessage)));
              await Promise.allSettled(captures.map((capture) => capture.result));
            }
            out.push(event);
          }
          out.end();
        })().catch(async (error) => {
          log.error('Anthropic hosted-search replay wrapper failed', error);
          await Promise.all(captures.map((capture) => capture.cancel(error)));
          await Promise.allSettled(captures.map((capture) => capture.result));
          out.push({ type: 'error', reason: 'error', error: replayError(model, error) });
          out.end();
        });
        return out;
      };
    },
  };
}

export function anthropicHostedReplayMetadata(message: Message): AnthropicHostedReplayMetadata | undefined {
  return replayMetadata(message);
}
