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

export interface ProviderRequestRecorderOptions {
  store: ProviderRequestStore;
  sessionId: string;
  configuredProvider: string;
  enabled: () => boolean;
  now?: () => number;
}

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
 * Correlates PI provider calls with its serial AgentSession lifecycle.
 *
 * AgentSession's normal stream installs extension callbacks into ModelRuntime options, but PI's manual and
 * automatic summarization paths call the same ModelRuntime directly and omit those callbacks. Wrapping the
 * session-scoped runtime is therefore the only seam that covers BOTH paths. Its onPayload callback first
 * runs PI's complete extension chain, then records the returned value, so capture still observes the final
 * post-transform body while compaction no longer disappears from the log.
 */
export class ProviderRequestRecorder {
  readonly observe: (event: AgentSessionEvent) => void;

  private activeRequestId: string | null = null;
  private activeKind: 'chat' | 'compaction' | 'remote_compaction' = 'chat';
  private lastFailedRequestId: string | null = null;
  private retryOf: string | undefined;
  private turn = 0;
  private compaction = 0;
  private compactionActive = false;
  private captureBroken = false;
  private readonly now: () => number;

  constructor(private readonly options: ProviderRequestRecorderOptions) {
    this.now = options.now ?? Date.now;
    this.observe = (event) => {
      try {
        switch (event.type) {
        case 'agent_start':
          this.turn += 1;
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
        this.breakCapture(`lifecycle capture failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
  }

  /** Arm retry_of only when a wrapper has verified that it is immediately reissuing the failed request. */
  armVerifiedRetry(): void {
    if (this.lastFailedRequestId) this.retryOf = this.lastFailedRequestId;
  }

  /** The provider-owned compaction endpoint bypasses ModelRuntime entirely (direct fetch in our wrapper),
   * so it reports through this explicit seam. The body is still the exact JSON passed to fetch; transport
   * headers and credentials never enter it. */
  startRemoteCompaction(model: Model<Api>, payload: unknown): string | undefined {
    if (this.captureBroken || !this.options.enabled()) return undefined;
    if (this.activeRequestId) {
      this.breakCapture(`provider request correlation invariant: remote compaction started before ${this.activeRequestId} terminated`);
      return undefined;
    }
    try {
      const started = this.options.store.start({
        sessionId: this.options.sessionId,
        turnId: `compaction:${this.compaction}`,
        kind: 'remote_compaction',
        configuredProvider: this.options.configuredProvider,
        wireProvider: model.provider,
        api: model.api,
        model: model.id,
        payload,
        startedAt: this.now(),
      });
      this.activeRequestId = started.requestId;
      this.activeKind = 'remote_compaction';
      return started.requestId;
    } catch (error) {
      this.breakCapture(`remote compaction capture failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  markRemoteCompactionResponse(requestId: string, status: number): void {
    if (this.activeRequestId !== requestId || this.activeKind !== 'remote_compaction') {
      this.breakCapture(`provider request correlation invariant: remote response mismatched ${requestId}`);
      return;
    }
    try { this.options.store.markResponse(requestId, status, this.now()); }
    catch (error) { this.breakCapture(`remote response capture failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  finishRemoteCompaction(requestId: string, result: { response?: unknown; errorCode?: string; errorMessage?: string }): void {
    if (this.activeRequestId !== requestId || this.activeKind !== 'remote_compaction') {
      this.breakCapture(`provider request correlation invariant: remote terminal mismatched ${requestId}`);
      return;
    }
    try {
      this.options.store.finish({
        requestId,
        status: result.errorCode ? 'error' : 'succeeded',
        response: result.response,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        finishedAt: this.now(),
      });
      this.activeRequestId = null;
      this.lastFailedRequestId = result.errorCode ? requestId : null;
    } catch (error) {
      this.breakCapture(`remote terminal capture failed: ${error instanceof Error ? error.message : String(error)}`);
    }
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
    const wrappedOptions = {
      ...options,
      onPayload: async (payload: unknown, requestModel: Model<Api>) => {
        const transformed = await originalPayload?.(payload, requestModel);
        const finalPayload = transformed === undefined ? payload : transformed;
        capturedRequestId = this.openAttempt(requestModel, finalPayload);
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
        } catch (error) { this.breakCapture(`response capture failed: ${error instanceof Error ? error.message : String(error)}`); }
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
        if (capturedRequestId) this.closeStreamError(capturedRequestId, failed);
        out.push({ type: 'error', reason: 'error', error: failed });
        out.end();
      }
    })();
    return out;
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
          this.breakCapture(`HTTP failure capture failed: ${error instanceof Error ? error.message : String(error)}`);
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
      this.breakCapture(`request capture failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
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
      this.breakCapture(`compaction terminal capture failed: ${error instanceof Error ? error.message : String(error)}`);
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
      this.breakCapture(`stream terminal capture failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private breakCapture(message: string): void {
    log.error(message);
    const pending = this.activeRequestId;
    this.activeRequestId = null;
    this.retryOf = undefined;
    this.lastFailedRequestId = null;
    this.captureBroken = true;
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
      log.error(`failed to close broken capture ${pending}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
