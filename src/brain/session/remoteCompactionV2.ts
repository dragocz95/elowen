import { convertResponsesMessages } from '@earendil-works/pi-ai/api/openai-responses-shared';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { Api, AssistantMessageEventStream, Context, Message, Model } from '@earendil-works/pi-ai';
import { convertToLlm } from '@earendil-works/pi-coding-agent';
import type { AgentSession, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { logger } from '../../shared/logger.js';
import { trimAllTrailingSlashes } from '../../shared/url.js';

/** pi-ai's `CODEX_TOOL_CALL_PROVIDERS` (openai-codex-responses.js) is module-private, so the same set is
 *  restated here. It decides which historical tool calls keep their provider-native ids during conversion;
 *  a mismatch would renumber call ids in the compaction request only, and the blob would then describe a
 *  history whose tool calls no longer line up with the live one. */
const CODEX_TOOL_CALL_PROVIDERS: ReadonlySet<string> = new Set(['openai', 'openai-codex', 'opencode']);

const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
/** The JWT claim ChatGPT OAuth tokens carry their account id under (pi-ai's JWT_CLAIM_PATH). */
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';

const log = logger('remote-compaction');

/**
 * The tag wrapping the opaque blob inside a compaction summary string.
 *
 * The blob has to survive a round trip through `brain_messages` in SQLite and back, and the only carrier
 * PI offers is `CompactionResult.summary` — a plain string. So the marker is plain text too: a versioned
 * tag around a JSON object. JSON rather than attributes because it gives escaping for free (the blob is
 * base64url today, but nothing in the protocol promises it stays that way), and the version lives in the
 * tag NAME so a future format is simply a tag this build does not recognize — it falls through to the
 * "unavailable" note instead of being mis-parsed.
 */
const MARKER_TAG = 'elowen-remote-compaction-v2';
const MARKER_RE = new RegExp(`<${MARKER_TAG}>(\\{.*?\\})</${MARKER_TAG}>`, 's');

/** What one stored marker carries: the blob plus the model slug that produced it. The slug is recorded
 *  because a blob is minted by one model and replayed by whichever model the conversation is on later —
 *  it is the only way to tell a rejection caused by a model switch from a genuinely stale blob. */
export interface CompactionMarker {
  model: string;
  blob: string;
}

/** The human half of the summary. PI stores the summary verbatim and Elowen's clients render it, so a
 *  compaction that is opaque to the model must not also be opaque to the reader. Only this half is ever
 *  shown; the marker below it is swapped out before the request leaves. */
function markerPreamble(model: string): string {
  return `The conversation history before this point was compacted by the provider into an opaque context `
    + `blob (remote compaction v2, model ${model}). The blob is restored into the model's context on every `
    + `request; it is not readable as text.`;
}

/** What replaces the marker when the blob cannot be used — a stale/rejected blob, or a session that moved
 *  to a provider which cannot read it. Deliberately short and honest: dropping the message silently would
 *  let the model narrate the missing stretch as if it never existed. */
export const COMPACTION_UNAVAILABLE_NOTE =
  'The conversation history before this point was compacted, but the compacted context could not be '
  + 'restored and is unavailable.';

export function encodeCompactionSummary(marker: CompactionMarker): string {
  return `${markerPreamble(marker.model)}\n\n<${MARKER_TAG}>${JSON.stringify(marker)}</${MARKER_TAG}>`;
}

/** Pull the marker back out of a stored summary, or null when the string does not carry one (a plain text
 *  summary from the fallback path, or a summary written by an older build). */
export function decodeCompactionMarker(summary: string): CompactionMarker | null {
  const match = MARKER_RE.exec(summary);
  if (!match?.[1]) return null;
  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (!parsed || typeof parsed !== 'object') return null;
    const { model, blob } = parsed as Record<string, unknown>;
    if (typeof model !== 'string' || typeof blob !== 'string' || blob.length === 0) return null;
    return { model, blob };
  } catch {
    return null;
  }
}

/**
 * Extract the single compaction item from a raw SSE body.
 *
 * Validated exactly as Codex validates it (`collect_compaction_output`, compact_remote_v2.rs): the stream
 * must complete AND carry precisely one compaction item. Zero means the backend ignored the trigger;
 * more than one means the protocol is not what this code was written against. Either way the blob would
 * be built on a guess, so both are refused rather than half-trusted.
 */
export function parseCompactionStream(body: string): string | null {
  let seen = 0;
  let blob: string | null = null;
  let completed = false;
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = event.type;
    if (type === 'response.completed' || type === 'response.done') completed = true;
    if (type !== 'response.output_item.done') continue;
    const item = event.item as Record<string, unknown> | undefined;
    if (item?.type !== 'compaction') continue;
    seen += 1;
    if (typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0) blob ??= item.encrypted_content;
  }
  if (!completed) {
    log.warn('compaction stream closed before response.completed');
    return null;
  }
  if (seen !== 1 || !blob) {
    log.warn(`expected exactly one compaction output item, got ${seen}`);
    return null;
  }
  return blob;
}

/** One history item as the Responses API takes it. Only ever produced by pi-ai's converter or by the two
 *  literals below, so the loose shape is the honest one. */
type ResponsesInputItem = Record<string, unknown>;

export interface CompactionRequestInput {
  model: Model<Api>;
  systemPrompt: string;
  /** The stretch of history the blob has to absorb, already flattened to plain LLM messages. */
  messages: readonly Message[];
  /** The previous compaction's blob, when this conversation has been compacted before. Chaining is
   *  supported by the backend and is transitive — a blob minted from a history that already held one
   *  still answers for the facts behind it — so the chain is passed through rather than dropped. */
  previousBlob?: string;
}

/**
 * The request body pi-ai would build for these messages, plus the trigger item.
 *
 * Deliberately mirrors `buildRequestBody` (openai-codex-responses.js) instead of inventing a shape: the
 * backend decides what a compaction covers from the input it is handed, so a request that differs from a
 * normal one produces a blob that describes a conversation the session never had. Tools are omitted —
 * tool DEFINITIONS are not conversation, and the historical calls and their outputs ride along inside
 * `messages` either way.
 */
export function buildCompactionRequestBody(input: CompactionRequestInput): Record<string, unknown> {
  const converted = convertResponsesMessages(
    input.model,
    { systemPrompt: input.systemPrompt, messages: [...input.messages] },
    CODEX_TOOL_CALL_PROVIDERS,
    { includeSystemPrompt: false },
  ) as unknown as ResponsesInputItem[];
  const items: ResponsesInputItem[] = [
    ...(input.previousBlob ? [{ type: 'compaction', encrypted_content: input.previousBlob }] : []),
    ...converted,
    // Last, always: the backend compacts what precedes the trigger.
    { type: 'compaction_trigger' },
  ];
  return {
    model: input.model.id,
    store: false,
    stream: true,
    instructions: input.systemPrompt || 'You are a helpful assistant.',
    input: items,
    text: { verbosity: 'low' },
    include: ['reasoning.encrypted_content'],
    tool_choice: 'auto',
    parallel_tool_calls: true,
  };
}

/** pi-ai's `resolveCodexUrl`: the configured base may already be the full endpoint, the `/codex` prefix,
 *  or the bare backend root. */
export function resolveCodexUrl(baseUrl: string | undefined): string {
  const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
  const normalized = trimAllTrailingSlashes(raw);
  if (normalized.endsWith('/codex/responses')) return normalized;
  if (normalized.endsWith('/codex')) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

/** The ChatGPT account id the request must be attributed to, read out of the OAuth token's own claim —
 *  the same derivation pi-ai does, so a re-login cannot leave this pointing at the previous account. */
export function accountIdFromToken(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    const scoped = claims[JWT_CLAIM_PATH] as Record<string, unknown> | undefined;
    const id = scoped?.chatgpt_account_id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

export interface RemoteCompactionCapture {
  start: (model: Model<Api>, payload: unknown) => string | undefined;
  response: (requestId: string, status: number) => void;
  finish: (requestId: string, result: { response?: unknown; errorCode?: string; errorMessage?: string }) => void;
}

export interface RemoteCompactionRequest extends CompactionRequestInput {
  token: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  capture?: RemoteCompactionCapture;
}

/**
 * Ask the backend to compact this history and return the opaque blob, or null on any problem at all.
 *
 * Null is the whole error contract. Every caller treats it as "remote compaction did not happen", which
 * hands the conversation back to PI's own text summarization — strictly better than Codex, which fails
 * the compaction outright. Nothing here throws, so a backend that changes shape degrades instead of
 * breaking every long conversation on the box.
 */
export async function requestRemoteCompaction(req: RemoteCompactionRequest): Promise<string | null> {
  const accountId = accountIdFromToken(req.token);
  if (!accountId) {
    log.warn('no chatgpt account id in the access token; skipping remote compaction');
    return null;
  }
  const doFetch = req.fetchImpl ?? fetch;
  const body = buildCompactionRequestBody(req);
  const captureId = req.capture?.start(req.model, body);
  let captureTerminal = false;
  try {
    const res = await doFetch(resolveCodexUrl(req.model.baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${req.token}`,
        'chatgpt-account-id': accountId,
        originator: 'pi',
        'OpenAI-Beta': 'responses=experimental',
        accept: 'text/event-stream',
        'content-type': 'application/json',
        // Not required today — the trigger is honored without it — but the endpoint is a beta the server
        // may start gating. Sending it costs one header and keeps the feature working if it ever does.
        'x-codex-beta-features': 'remote_compaction_v2',
      },
      body: JSON.stringify(body),
      ...(req.signal ? { signal: req.signal } : {}),
    });
    if (captureId) req.capture?.response(captureId, res.status);
    if (!res.ok) {
      if (captureId) {
        captureTerminal = true;
        req.capture?.finish(captureId, {
          errorCode: `http_${res.status}`,
          errorMessage: `Remote compaction returned HTTP ${res.status}`,
        });
      }
      log.warn(`remote compaction request failed with HTTP ${res.status}`);
      return null;
    }
    const blob = parseCompactionStream(await res.text());
    if (captureId) {
      captureTerminal = true;
      req.capture?.finish(captureId, blob
        ? { response: { encryptedContent: blob } }
        : { errorCode: 'invalid_response', errorMessage: 'Remote compaction returned no encrypted content' });
    }
    return blob;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (captureId && !captureTerminal) {
      captureTerminal = true;
      req.capture?.finish(captureId, { errorCode: 'request_error', errorMessage: message });
    }
    log.warn(`remote compaction request errored: ${message}`);
    return null;
  }
}

// ============================================================================
// Session wiring
// ============================================================================

/** Blobs this live session has watched the provider refuse. In memory only: the blob still sits in the
 *  stored summary, so a respawn pays one rejected request to rediscover it and then heals the same way.
 *  Persisting the verdict would mean writing a provider-side judgement into the transcript, and the
 *  judgement can change (a re-login, a server-side rollout) while the transcript cannot. */
class RejectedBlobs {
  private readonly blobs = new Set<string>();
  reject(blob: string): void { this.blobs.add(blob); }
  has(blob: string): boolean { return this.blobs.has(blob); }
}

/** The provider drops the `invalid_encrypted_content` CODE on its way through pi-ai's error parsing
 *  (`parseErrorResponse` keeps only `error.message`), so the wording is all that reaches us:
 *  "The encrypted content gAAA…AAAA could not be verified. Reason: Encrypted content could not be
 *  decrypted or parsed." This is only ever consulted for a request that carried one of OUR blobs, which
 *  keeps the match from having to be sharper than the text allows. */
function isStaleBlobError(message: string | undefined): boolean {
  return message !== undefined && /encrypted content/i.test(message);
}

/** The marker inside an already-flattened LLM message list — the shape the stream function sees, after
 *  `convertToLlm` has rendered the compaction summary into a user message. */
function markerInMessages(messages: readonly Message[]): CompactionMarker | null {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const content = message.content;
    if (typeof content === 'string') {
      const marker = decodeCompactionMarker(content);
      if (marker) return marker;
      continue;
    }
    for (const part of content) {
      if (part.type !== 'text') continue;
      const marker = decodeCompactionMarker(part.text);
      if (marker) return marker;
    }
  }
  return null;
}

/** The text of one Responses input item, when it is a user message. pi-ai emits user items WITHOUT a
 *  `type` field (see convertResponsesMessages), so the role is the only thing to key off. */
function userItemText(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const record = item as Record<string, unknown>;
  if (record.role !== 'user' || !Array.isArray(record.content)) return null;
  const texts = record.content
    .filter((part): part is { type: string; text: string } =>
      !!part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string')
    .map((part) => part.text);
  return texts.length > 0 ? texts.join('') : null;
}

/**
 * Swap every marker-carrying item in an outgoing `input` array for the real thing.
 *
 * A live blob becomes a `compaction` item, which is what the backend understands and the only reason the
 * marker exists. A rejected one becomes the honest note instead — the blob must never travel as text,
 * both because a kilobyte of base64 buys the model nothing and because it would then be indistinguishable
 * from conversation content on the next compaction.
 *
 * Returns null when nothing matched, so the caller can leave the payload untouched.
 */
export function substituteCompactionItems(input: readonly unknown[], rejected: (blob: string) => boolean): unknown[] | null {
  let changed = false;
  const next = input.map((item) => {
    const text = userItemText(item);
    if (text === null) return item;
    const marker = decodeCompactionMarker(text);
    if (!marker) return item;
    changed = true;
    if (rejected(marker.blob)) {
      return { role: 'user', content: [{ type: 'input_text', text: COMPACTION_UNAVAILABLE_NOTE }] };
    }
    return { type: 'compaction', encrypted_content: marker.blob };
  });
  return changed ? next : null;
}

export interface RemoteCompactionV2Deps {
  /** Read live on every compaction and every request, so the operator switch applies without a respawn. */
  enabled: () => boolean;
  /** The session's model. Also the model the blob is minted with and replayed against. */
  model: Model<Api>;
  /** Instructions for the compaction request — the composed system prompt this session runs on. */
  systemPrompt: () => string;
  /** The ChatGPT OAuth bearer, resolved (and refreshed) through the runtime the same way a turn does. */
  token: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  capture?: RemoteCompactionCapture;
  /** Verified stale-blob retry signal for request-attempt correlation. */
  onStaleBlobRetry?: () => void;
}

export interface RemoteCompactionV2 {
  extension: (pi: ExtensionAPI) => void;
  /** Installed after PI has built the Agent, mirroring {@link CompactionModelRoute.install}. */
  install(session: AgentSession): void;
}

/**
 * Replace PI's text summarization with the provider's own opaque compaction, for one ChatGPT-account
 * session.
 *
 * Three seams, because the blob has three distinct moments:
 *  - `session_before_compact` mints it and hands PI a ready-made {@link CompactionResult}, so PI skips
 *    its own summarization entirely. Returning `undefined` puts PI's text summary back in charge — that
 *    fallback is what makes this safe to enable, and is deliberately better than Codex, which fails the
 *    compaction when the remote call does not produce a blob.
 *  - `before_provider_request` restores it: the stored summary is a marker, and only here — after pi-ai
 *    has built the Responses payload — can it become a real `compaction` input item.
 *  - {@link install} recovers from a blob the provider refuses.
 */
export function createRemoteCompactionV2(deps: RemoteCompactionV2Deps): RemoteCompactionV2 {
  const rejected = new RejectedBlobs();
  const isRejected = (blob: string): boolean => rejected.has(blob);
  const installedOn = new WeakSet<AgentSession['agent']>();

  return {
    extension(pi) {
      pi.on('session_before_compact', async (event) => {
        if (!deps.enabled()) return undefined;
        const preparation = event.preparation;
        const previous = preparation.previousSummary ? decodeCompactionMarker(preparation.previousSummary) : null;
        const token = await deps.token();
        const blob = token
          ? await requestRemoteCompaction({
            model: deps.model,
            systemPrompt: deps.systemPrompt(),
            // `turnPrefixMessages` follows `messagesToSummarize` in time (PI cuts at turnStartIndex), and
            // both stretches are dropped from the live context — so both must be inside the blob.
            messages: convertToLlm([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]),
            // A blob the provider already refused would only make this request fail the same way.
            ...(previous && !isRejected(previous.blob) ? { previousBlob: previous.blob } : {}),
            token,
            signal: event.signal,
            ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
            ...(deps.capture ? { capture: deps.capture } : {}),
          })
          : null;
        if (!blob) {
          // PI reuses this exact `preparation` object for its own `compact()` right after the handler
          // returns, and would feed `previousSummary` to the summarizer as the text to update. A marker
          // is base64, not prose. Clearing it makes PI summarize the retained window from scratch, which
          // is the truth: this build holds no textual summary of what came before.
          if (previous) preparation.previousSummary = undefined;
          // Undefined, never `cancel` — PI must fall through to its own text summarization.
          return undefined;
        }
        return {
          compaction: {
            summary: encodeCompactionSummary({ model: deps.model.id, blob }),
            firstKeptEntryId: preparation.firstKeptEntryId,
            tokensBefore: preparation.tokensBefore,
          },
        };
      });

      pi.on('before_provider_request', (event) => {
        if (!deps.enabled()) return undefined;
        const payload = event.payload as { input?: unknown } | null | undefined;
        if (!payload || !Array.isArray(payload.input)) return undefined;
        const input = substituteCompactionItems(payload.input, isRejected);
        return input ? { ...payload, input } : undefined;
      });
    },

    install(session) {
      const agent = session.agent;
      if (installedOn.has(agent)) return;
      installedOn.add(agent);
      const nativeStream = agent.streamFunction;
      agent.streamFunction = (model, context, options) => {
        if (!deps.enabled()) return nativeStream(model, context, options);
        const marker = markerInMessages(context.messages);
        // Transparent unless this request actually carries a live blob: every other request gets the
        // native stream object itself, not a proxy of it.
        if (!marker || isRejected(marker.blob)) return nativeStream(model, context, options);
        return streamWithStaleBlobRecovery(nativeStream, model, context, options, marker.blob, rejected, deps.onStaleBlobRetry);
      };
    },
  };
}

/**
 * Run one request, and re-run it once if the provider refuses the blob it carried.
 *
 * This is the only seam that can do it. `before_provider_request` is where the blob enters the payload
 * but it never sees the response; the `context` hook runs once per turn, BEFORE the request, so it cannot
 * react either; and PI exposes no provider-error hook at all. The stream function is the one place that
 * both observes the failure and still holds everything needed to issue the call again — the same reason
 * {@link createCompactionModelRoute} wraps it.
 *
 * The retry is safe precisely because pi-ai emits nothing before the response is known to be OK: a 400
 * arrives as the FIRST event on the stream, so nothing has been forwarded and the second attempt is
 * indistinguishable from a first one. Once any event has gone out, the door is closed and the error is
 * forwarded like any other.
 */
function streamWithStaleBlobRecovery(
  nativeStream: (model: Model<Api>, context: Context, options?: Parameters<AgentSession['agent']['streamFunction']>[2]) =>
  AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
  model: Model<Api>,
  context: Context,
  options: Parameters<AgentSession['agent']['streamFunction']>[2],
  blob: string,
  rejected: RejectedBlobs,
  onRetry?: () => void,
): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  void (async () => {
    for (let attempt = 0; ; attempt++) {
      const inner = await nativeStream(model, context, options);
      let forwarded = 0;
      let retrying = false;
      for await (const event of inner) {
        if (attempt === 0 && forwarded === 0 && event.type === 'error' && isStaleBlobError(event.error.errorMessage)) {
          log.warn('provider refused the stored compaction blob; retrying this request without it');
          rejected.reject(blob);
          onRetry?.();
          retrying = true;
          break;
        }
        forwarded += 1;
        out.push(event);
      }
      if (retrying) continue;
      // No synthetic terminal event: a stream that never pushed `done`/`error` leaves `result()` pending
      // here exactly as it would have without the wrapper, so wrapping cannot change a caller's outcome.
      out.end();
      return;
    }
  })();
  return out;
}

/**
 * Strip markers this session cannot honor, for ANY provider.
 *
 * A conversation keeps its history across a model switch, so a summary minted on the ChatGPT backend can
 * end up in a request to Anthropic — where nothing swaps it and the blob would be sent as a kilobyte of
 * base64 text. This runs on the `context` hook, which is provider-agnostic and per-request (PI's
 * `transformContext` uses the result for that one call and never writes it back), so the stored
 * transcript keeps the blob for the day the conversation moves back.
 *
 * Registered for EVERY session, not just ChatGPT ones — the session that leaks is by definition the one
 * that can no longer use the feature.
 */
export function installCompactionMarkerSanitizer(pi: ExtensionAPI, usable: () => boolean): void {
  pi.on('context', (event) => {
    if (usable()) return undefined;
    let changed = false;
    const messages = event.messages.map((message) => {
      if (message.role !== 'compactionSummary' || !decodeCompactionMarker(message.summary)) return message;
      changed = true;
      return { ...message, summary: COMPACTION_UNAVAILABLE_NOTE };
    });
    return changed ? { messages } : undefined;
  });
}
