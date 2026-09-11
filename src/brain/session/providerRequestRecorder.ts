import {
  type AgentSessionEvent,
  type ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
} from '@earendil-works/pi-ai';
import type { ProviderRequestStore, ProviderRequestUsage } from '../../store/providerRequestStore.js';
import { logger } from '../../shared/logger.js';

const log = logger('provider-request-recorder');

function captureError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' ? `${code}: ${message}` : message;
}

export interface ProviderRequestRecorderOptions {
  store: ProviderRequestStore;
  sessionId: string;
  configuredProvider: string;
  enabled: () => boolean;
  now?: () => number;
  /** Monotonic clock for effective-speed timing (wall `now` can jump). Defaults to performance.now. */
  monoNow?: () => number;
}

/** Effective-speed timing stamped onto the terminal assistant message, measured at the streamSimple
 *  seam — the request's INITIATION, before the provider's response headers are awaited — and persisted
 *  by the session projector alongside the legacy post-header `durationMs`. Both live on the message,
 *  so the statusline, the stats aggregates and rehydrated history read one representation:
 *  - `effectiveMs`: the whole logical request, monotonic ms. Includes the wait for the provider's
 *    response headers (prompt processing, queueing, and — for a buffered delivery — the entire
 *    server-side generation that never streams), plus every auto-retry and its backoff. Excludes tool
 *    execution between model calls, which happens outside any single request.
 *  - `firstContentMs`: single-attempt calls only, from initiation to the FIRST streamed content event
 *    (thinking, text, or a tool call). A retried call has no honest single wait-to-first-content, so
 *    the field is absent there rather than faked. It is NOT a time-to-first-hidden-token figure. */
export interface EffectiveRequestTiming { effectiveMs?: number; firstContentMs?: number }

function assistantUsage(message: AssistantMessage): ProviderRequestUsage {
  const usage = message.usage;
  return {
    input: usage.input,
    output: usage.output,
    reasoning: usage.reasoning,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    cost: usage.cost,
  };
}

function assistantId(message: AssistantMessage): string | undefined {
  const id = (message as unknown as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

function eventError(event: AssistantMessageEvent): AssistantMessage | undefined {
  return event.type === 'error' ? event.error : undefined;
}

/**
 * Correlates PI provider calls with its serial AgentSession lifecycle, and times those calls the way
 * the client experienced them.
 *
 * AgentSession's normal stream installs extension callbacks into ModelRuntime options, but PI's manual and
 * automatic summarization paths call the same ModelRuntime directly and omit those callbacks. Wrapping the
 * session-scoped runtime is therefore the only seam that covers BOTH paths. Its onPayload callback first
 * runs PI's complete extension chain, then records the returned value, so capture still observes the final
 * post-transform body while compaction no longer disappears from the log.
 *
 * The same wrapper is the canonical effective-speed seam: a logical request is timed with a monotonic
 * clock from the streamSimple call (before any header wait) to its terminal event, across PI auto-retries,
 * and stamped onto the terminal message as {@link EffectiveRequestTiming}. It works for every transport
 * (HTTP and the Codex WebSocket) because it never depends on transport-specific hooks.
 */
export class ProviderRequestRecorder {
  readonly observe: (event: AgentSessionEvent) => void;

  private activeRequestId: string | null = null;
  private activeKind: 'chat' | 'compaction' = 'chat';
  private lastFailedRequestId: string | null = null;
  private retryOf: string | undefined;
  private turn = 0;
  private compaction = 0;
  private compactionActive = false;
  private captureBroken = false;
  private readonly now: () => number;
  private readonly mono: () => number;
  /** Effective-speed chain state. `requestStartMono` is the open logical request's monotonic start;
   *  it survives a FAILED attempt (a retry carries the same request forward, backoff included) and is
   *  cleared when the request completes, a new agent run starts, or the session settles. Timing is
   *  capture-independent: capture rows gate only the request debugger, never these numbers. */
  private requestStartMono: number | null = null;
  private requestAttempts = 0;
  private requestRetryCarried = false;
  private attemptStartMono = 0;
  private attemptFirstContentMs: number | null = null;

  constructor(private readonly options: ProviderRequestRecorderOptions) {
    this.now = options.now ?? Date.now;
    this.mono = options.monoNow ?? (() => performance.now());
    this.observe = (event) => {
      try {
        switch (event.type) {
        case 'agent_start':
          // Disable a broken capture for its turn, not for the lifetime of a reused session.
          this.captureBroken = false;
          this.turn += 1;
          // A new agent run is a new logical request — no stale chain may reach into it. PI's
          // auto-retry is the one exception: the retry re-enters the loop as a NEW run (a fresh
          // agent_start) while the client has been waiting through ONE logical request, so a carried
          // retry keeps the chain it was handed.
          if (!this.requestRetryCarried) {
            this.requestStartMono = null;
            this.requestAttempts = 0;
          }
          return;
        case 'compaction_start':
          this.compaction += 1;
          this.compactionActive = true;
          return;
        case 'compaction_end': {
          this.compactionActive = false;
          if (!this.activeRequestId || this.activeKind !== 'compaction') return;
          const requestId = this.activeRequestId;
          const succeeded = !event.aborted && !!event.result;
          this.options.store.finish({
            requestId,
            status: succeeded ? 'succeeded' : 'error',
            response: event.result,
            usage: event.result?.usage,
            errorCode: event.aborted ? 'aborted' : event.result ? undefined : 'compaction_failed',
            errorMessage: event.errorMessage,
            finishedAt: this.now(),
          });
          this.activeRequestId = null;
          this.lastFailedRequestId = succeeded ? null : requestId;
          return;
        }
        case 'auto_retry_start':
          // The retry continues the SAME logical request for effective-speed timing (its backoff
          // included), whether or not capture wrote rows for either attempt.
          this.requestRetryCarried = true;
          if (this.activeRequestId) {
            this.breakCapture(`provider request correlation invariant: retry started while ${this.activeRequestId} is pending`);
            return;
          }
          // Capture may have been disabled for the failed request. With no verified captured predecessor,
          // leave retry_of empty rather than linking to an older unrelated attempt.
          if (this.lastFailedRequestId) this.retryOf = this.lastFailedRequestId;
          return;
        case 'auto_retry_end':
          if (!event.success) this.retryOf = undefined;
          return;
        case 'summarization_retry_attempt_start':
          if (event.source === 'compaction' && this.lastFailedRequestId) this.retryOf = this.lastFailedRequestId;
          return;
        case 'summarization_retry_finished':
          this.retryOf = undefined;
          return;
        case 'agent_settled':
          this.retryOf = undefined;
          this.lastFailedRequestId = null;
          // The run is over: an open logical request (an attempt that never terminalized) stays open
          // no longer, so its wait can never bleed into the next turn.
          this.requestStartMono = null;
          this.requestAttempts = 0;
          this.requestRetryCarried = false;
          return;
        case 'message_end': {
          if (event.message.role !== 'assistant') return;
          const message = event.message;
          if (!this.activeRequestId) return;
          if (this.activeKind === 'compaction') {
            this.options.store.attachResponse(this.activeRequestId, message, assistantId(message));
            return;
          }
          const requestId = this.activeRequestId;
          const failed = message.stopReason === 'error' || message.stopReason === 'aborted';
          this.options.store.finish({
            requestId,
            status: failed ? 'error' : 'succeeded',
            response: message,
            assistantMessageId: assistantId(message),
            usage: assistantUsage(message),
            errorCode: failed ? message.stopReason : undefined,
            errorMessage: message.errorMessage,
            finishedAt: this.now(),
          });
          this.activeRequestId = null;
          this.lastFailedRequestId = failed ? requestId : null;
          return;
        }
        case 'agent_end':
          if (this.activeRequestId && this.activeKind === 'chat') {
            const requestId = this.activeRequestId;
            this.options.store.finish({
              requestId,
              status: 'error',
              errorCode: 'missing_message_end',
              errorMessage: 'Agent ended without a terminal assistant message for the provider request',
              finishedAt: this.now(),
            });
            this.activeRequestId = null;
              this.lastFailedRequestId = requestId;
            log.error(`request ${requestId} ended without message_end`);
          }
          return;
          default:
            return;
        }
      } catch (error) {
        this.breakCapture(`lifecycle capture failed: ${captureError(error)}`);
      }
    };
  }

  /** A session-local proxy: every method remains bound to the real ModelRuntime, only streamSimple is
   * wrapped. This avoids mutating the shared runtime used by other live sessions. */
  wrapRuntime(runtime: ModelRuntime): ModelRuntime {
    const recorder = this;
    return new Proxy(runtime, {
      get(target, property, receiver) {
        if (property === 'streamSimple') {
          return (model: Model<Api>, context: Parameters<ModelRuntime['streamSimple']>[1], options: Parameters<ModelRuntime['streamSimple']>[2]) =>
            recorder.streamSimple(target, model, context, options);
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  private streamSimple(
    runtime: ModelRuntime,
    model: Model<Api>,
    context: Parameters<ModelRuntime['streamSimple']>[1],
    options: Parameters<ModelRuntime['streamSimple']>[2],
  ) {
    const originalPayload = options?.onPayload;
    const originalResponse = options?.onResponse;
    let capturedRequestId: string | undefined;
    // Effective-speed timing starts HERE — the request's initiation, before the provider's response
    // headers are awaited (the projector's post-header `durationMs` cannot see header waits or a
    // buffered delivery). A chat attempt whose predecessor FAILED carries the same logical request
    // forward: PI's auto-retries and their backoff are part of what the client waited through. Tool
    // execution between calls never touches this state — it happens between streamSimple calls, and
    // only a retry carries the chain on. Compaction is decided from PI's compaction bracket, not from
    // capture rows, so capture being off can never misclassify a stream.
    const attemptStartMono = this.mono();
    const isCompaction = this.compactionActive;
    if (!isCompaction) {
      if (this.requestRetryCarried && this.requestStartMono != null) this.requestAttempts += 1;
      else { this.requestStartMono = attemptStartMono; this.requestAttempts = 1; }
      this.requestRetryCarried = false;
    }
    this.attemptStartMono = attemptStartMono;
    this.attemptFirstContentMs = null;
    const wrappedOptions = {
      ...options,
      onPayload: async (payload: unknown, requestModel: Model<Api>) => {
        const transformed = await originalPayload?.(payload, requestModel);
        const finalPayload = transformed === undefined ? payload : transformed;
        // Reconciliation also reads SQLite; diagnostics must never reject the provider's payload hook.
        try { capturedRequestId = this.openAttempt(requestModel, finalPayload); }
        catch (error) { this.breakCapture(`request capture failed: ${captureError(error)}`); }
        return finalPayload;
      },
      onResponse: async (response: Parameters<NonNullable<typeof originalResponse>>[0], responseModel: Model<Api>) => {
        await originalResponse?.(response, responseModel);
        // The kill switch is sampled at onPayload for this exact provider call. A response for an
        // uncaptured request remains uncaptured even if the operator enabled capture while it was running.
        if (!capturedRequestId) return;
        if (this.activeRequestId !== capturedRequestId) {
          this.breakCapture(`provider request correlation invariant: response mismatched ${capturedRequestId}`);
          return;
        }
        try {
          // A response to an attempt that is no longer pending is not a correlation fault of this
          // recorder: the row was closed from outside (a pause or boot reconcile, an earlier terminal).
          // Report it and carry on; the next openAttempt reconciles the stale in-memory pointer.
          if (!this.options.store.markResponse(capturedRequestId, response.status, this.now())) {
            log.warn(`response for ${capturedRequestId} arrived after the attempt was closed as ${this.closedAs(capturedRequestId)} — not recorded`);
          }
        } catch (error) { this.breakCapture(`response capture failed: ${captureError(error)}`); }
      },
    };
    const out = createAssistantMessageEventStream();
    void (async () => {
      try {
        const inner = runtime.streamSimple(model, context, wrappedOptions);
        for await (const event of inner) {
          const error = eventError(event);
          if (error && capturedRequestId) this.closeStreamError(capturedRequestId, error);
          // A compaction attempt terminates on its own stream: PI's compaction emits no message_end, and
          // a split-turn compaction issues TWO sequential calls (history summary, then turn-prefix summary)
          // inside one compaction_start/compaction_end bracket, so waiting for compaction_end left the
          // first call pending when the second opened. compaction_end still closes an attempt that never
          // produced a terminal event (an abort before the first token).
          else if (event.type === 'done' && capturedRequestId && this.activeKind === 'compaction') this.closeCompactionCall(capturedRequestId, event.message);
          if (!isCompaction) this.timeStreamEvent(event);
          out.push(event);
        }
        out.end();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const failed: AssistantMessage = {
          role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
          usage: {
            input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'error', errorMessage, timestamp: this.now(),
        };
        if (!isCompaction) this.timeFailedAttempt(failed);
        if (capturedRequestId) this.closeStreamError(capturedRequestId, failed);
        out.push({ type: 'error', reason: 'error', error: failed });
        out.end();
      }
    })();
    return out;
  }

  /** Effective-speed timing over one chat stream. The first content event fixes this attempt's
   *  wait-to-first-content; a terminal stamps the timing onto the terminal message — the very object
   *  the agent loop replays as `message_end`, so the projector persists it with the message. */
  private timeStreamEvent(event: AssistantMessageEvent): void {
    if (event.type === 'text_start' || event.type === 'thinking_start' || event.type === 'toolcall_start') {
      if (this.attemptFirstContentMs == null) this.attemptFirstContentMs = Math.max(0, this.mono() - this.attemptStartMono);
      return;
    }
    if (event.type === 'done') {
      // The logical request is over: stamp its whole span, then close the chain so the NEXT
      // streamSimple call (the next tool-loop step) starts a fresh one.
      this.stampEffective(event.message, true);
      return;
    }
    if (event.type === 'error') this.stampEffective(event.error, false);
  }

  /** A stream that THREW (no terminal event) still waited: stamp the synthetic failure message the
   *  wrapper emits so the attempt's window is measured and distinguishable via its error stopReason. */
  private timeFailedAttempt(message: AssistantMessage): void {
    this.stampEffective(message, false);
  }

  /** Stamp the logical-request timing onto the terminal message. The numerator stays whatever output
   *  the provider reports (set separately on `usage`); nothing is invented or clipped here. A
   *  COMPLETED call closes the chain — a later streamSimple call is a new logical request. A FAILED
   *  one keeps the chain open for the retry that may follow. */
  private stampEffective(message: AssistantMessage, completed: boolean): void {
    if (this.requestStartMono == null) return;
    const effectiveMs = Math.max(0, this.mono() - this.requestStartMono);
    (message as { effectiveMs?: number }).effectiveMs = effectiveMs;
    if (completed && this.requestAttempts === 1 && this.attemptFirstContentMs != null) {
      (message as { firstContentMs?: number }).firstContentMs = this.attemptFirstContentMs;
    }
    if (completed) {
      this.requestStartMono = null;
      this.requestAttempts = 0;
    }
  }

  private openAttempt(model: Model<Api>, payload: unknown): string | undefined {
    if (this.captureBroken) return undefined;
    if (this.activeRequestId) {
      const row = this.options.store.row(this.activeRequestId);
      const httpStatus = row?.http_status;
      if (!row || row.status !== 'pending') {
        // Closed from outside while this correlator still pointed at it — a pause or boot reconcile
        // marked it interrupted, or its session was deleted. The live turn is unaffected and the new
        // request is a fresh attempt, so drop the stale pointer instead of declaring an invariant breach.
        log.warn(`attempt ${this.activeRequestId} was closed as ${this.closedAs(this.activeRequestId, row)} before its stream ended — opening a new attempt`);
        this.activeRequestId = null;
        this.retryOf = undefined;
        this.lastFailedRequestId = null;
      } else if (typeof httpStatus === 'number' && httpStatus >= 400) {
        const failed = this.activeRequestId;
        try {
          this.options.store.finish({
            requestId: failed,
            status: 'error',
            errorCode: `http_${httpStatus}`,
            errorMessage: `Provider returned HTTP ${httpStatus}`,
            finishedAt: this.now(),
          });
        } catch (error) {
          this.breakCapture(`HTTP failure capture failed: ${captureError(error)}`);
          return undefined;
        }
        this.lastFailedRequestId = failed;
        this.retryOf = failed;
        this.activeRequestId = null;
      } else {
        this.breakCapture(`provider request correlation invariant: request started before ${this.activeRequestId} terminated`);
        return undefined;
      }
    }
    if (!this.options.enabled()) {
      // An uncaptured attempt breaks any retry chain. A later re-enabled attempt must not jump across it.
      this.retryOf = undefined;
      this.lastFailedRequestId = null;
      return undefined;
    }
    const kind = this.compactionActive ? 'compaction' : 'chat';
    const turnId = kind === 'compaction' ? `compaction:${this.compaction}` : `turn:${this.turn}`;
    try {
      this.reconcileOrphanedAttempt();
      const started = this.options.store.start({
        sessionId: this.options.sessionId,
        turnId,
        retryOf: this.retryOf,
        kind,
        configuredProvider: this.options.configuredProvider,
        wireProvider: model.provider,
        api: model.api,
        model: model.id,
        payload,
        startedAt: this.now(),
      });
      this.activeRequestId = started.requestId;
      this.activeKind = kind;
      this.retryOf = undefined;
      return started.requestId;
    } catch (error) {
      this.breakCapture(`request capture failed: ${captureError(error)}`);
      return undefined;
    }
  }

  /** Only called before a fresh capture with no locally active request. AgentSession serializes calls;
   *  a pending row here belongs to a retired correlator or to a closure that exhausted its busy retries. */
  private reconcileOrphanedAttempt(): void {
    if (!this.options.store.latestPending(this.options.sessionId)) return;
    const closed = this.options.store.interruptPending({
      errorCode: 'capture_failed',
      errorMessage: 'Previous capture did not close before the next provider request',
    }, { sessionId: this.options.sessionId, at: this.now() });
    this.retryOf = undefined;
    this.lastFailedRequestId = null;
    for (const id of closed) log.warn(`orphaned attempt ${id} interrupted after capture failure — opening a new attempt`);
  }

  /** Human-readable terminal state of a row that is no longer pending, for the warnings above. */
  private closedAs(requestId: string, row = this.options.store.row(requestId)): string {
    if (!row) return 'deleted';
    const code = typeof row.error_code === 'string' && row.error_code ? ` (${row.error_code})` : '';
    return `${String(row.status)}${code}`;
  }

  private closeCompactionCall(requestId: string, message: AssistantMessage): void {
    if (this.activeRequestId !== requestId) {
      this.breakCapture(`provider request correlation invariant: compaction terminal mismatched ${requestId}`);
      return;
    }
    try {
      this.options.store.finish({
        requestId,
        status: 'succeeded',
        response: message,
        assistantMessageId: assistantId(message),
        usage: assistantUsage(message),
        finishedAt: this.now(),
      });
      this.activeRequestId = null;
      this.lastFailedRequestId = null;
    } catch (error) {
      this.breakCapture(`compaction terminal capture failed: ${captureError(error)}`);
    }
  }

  private closeStreamError(requestId: string, message: AssistantMessage): void {
    if (this.activeRequestId !== requestId) {
      this.breakCapture(`provider request correlation invariant: stream terminal mismatched ${requestId}`);
      return;
    }
    try {
      this.options.store.finish({
        requestId,
        status: 'error',
        response: message,
        assistantMessageId: assistantId(message),
        usage: assistantUsage(message),
        errorCode: message.stopReason,
        errorMessage: message.errorMessage,
        finishedAt: this.now(),
      });
      this.activeRequestId = null;
      this.lastFailedRequestId = requestId;
    } catch (error) {
      this.breakCapture(`stream terminal capture failed: ${captureError(error)}`);
    }
  }

  private breakCapture(message: string): void {
    log.error(message);
    const pending = this.activeRequestId;
    this.activeRequestId = null;
    this.retryOf = undefined;
    this.lastFailedRequestId = null;
    this.captureBroken = true;
    // Timing state cannot survive a broken correlation either: a fresh chain keeps the next call's
    // measurement honest instead of silently extending a window that was lost.
    this.requestStartMono = null;
    this.requestAttempts = 0;
    this.requestRetryCarried = false;
    if (!pending) return;
    try {
      this.options.store.finish({
        requestId: pending,
        status: 'error',
        errorCode: 'correlation_invariant',
        errorMessage: message,
        finishedAt: this.now(),
      });
    } catch (error) {
      log.error(`failed to close broken capture ${pending}: ${captureError(error)}`);
    }
  }
}
