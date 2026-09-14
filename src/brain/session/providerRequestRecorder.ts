import { randomUUID } from 'node:crypto';
import {
  type AgentSession,
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
import { addSpeedSample, speedOf, type SpeedAggregate } from '../../shared/effectiveSpeed.js';
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

/** Canonical speed timing persisted on successful terminal assistant messages.
 *
 *  `effectiveMs` is this request's successful provider-generation window from the accepted response stream
 *  start to terminal stream completion. It excludes request queue/connect wait, failed attempts, retry
 *  backoff, tool execution and all between-request waiting. `effectiveTimingVersion: 3` distinguishes this
 *  contract from older rows whose effectiveMs included queue/retry time and excluded tool-call responses.
 *
 *  The turn fields are the exact cumulative pair across every valid successful request in the current
 *  agent run and model identity. They are repeated on later successful messages so a status snapshot keeps
 *  the aggregate through tool transitions and compaction without recomputing from wall time.
 *
 *  `firstContentMs` remains user-perceived wait from request initiation to the first streamed content on a
 *  single attempt. It is not part of the speed denominator. */
export interface EffectiveRequestTiming {
  effectiveTimingVersion?: 3;
  effectiveMs?: number;
  effectiveTurnId?: string;
  effectiveModel?: string;
  effectiveTurnOutput?: number;
  effectiveTurnMs?: number;
  firstContentMs?: number;
}

export interface EffectiveTurnState {
  turnId: string;
  model?: string;
  output: number;
  elapsedMs: number;
  firstContentMs?: number;
}

/** Live turn identity and cumulative measured pair for status snapshots. Weak ownership prevents a disposed
 *  session from being retained solely for telemetry. */
const effectiveTurns = new WeakMap<AgentSession, EffectiveTurnState>();
export function effectiveTurnStateOf(session: AgentSession): EffectiveTurnState | undefined {
  const state = effectiveTurns.get(session);
  return state ? { ...state } : undefined;
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
 * Correlates PI provider calls with its serial AgentSession lifecycle, and times those calls the way
 * the client experienced them.
 *
 * AgentSession's normal stream installs extension callbacks into ModelRuntime options, but PI's manual and
 * automatic summarization paths call the same ModelRuntime directly and omit those callbacks. Wrapping the
 * session-scoped runtime is therefore the only seam that covers BOTH paths. Its onPayload callback first
 * runs PI's complete extension chain, then records the returned value, so capture still observes the final
 * post-transform body while compaction no longer disappears from the log.
 *
 * The same wrapper is the canonical effective-speed seam: every successful request is timed with a
 * monotonic clock from the `start` stream event to its terminal event, then folded into the current
 * turn/model aggregate and stamped as {@link EffectiveRequestTiming}. It works for every transport
 * (HTTP and the Codex WebSocket) because stream events, unlike the `onResponse` HTTP-header callback,
 * are emitted by every PI dialect.
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
  /** Timing is capture-independent: capture rows gate only the request debugger, never these numbers. */
  private requestAttempts = 0;
  private requestRetryCarried = false;
  private attemptStartMono = 0;
  private attemptResponseMono: number | null = null;
  private attemptFirstContentMs: number | null = null;
  private turnId = randomUUID();
  private turnModel: string | undefined;
  private turnAggregate: SpeedAggregate = { output: 0, elapsedMs: 0 };
  private boundSession: AgentSession | undefined;

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
          // A new agent run is a hard speed boundary. PI's auto-retry re-enters as agent_start while the
          // same turn is still open, so only that explicit carry preserves the identity and aggregate.
          if (!this.requestRetryCarried) {
            this.requestAttempts = 0;
            this.turnId = randomUUID();
            this.turnModel = undefined;
            this.turnAggregate = { output: 0, elapsedMs: 0 };
            this.publishTurnState();
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
          // The run is over: an unterminated attempt must never bleed into the next turn.
          this.attemptResponseMono = null;
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
    // Request initiation is retained only for first-content latency. The speed denominator begins later,
    // when onResponse confirms accepted headers for this exact attempt. Failed attempts and retry backoff
    // therefore never enter a successful sample. Compaction is outside chat speed entirely.
    const attemptStartMono = this.mono();
    const isCompaction = this.compactionActive;
    if (!isCompaction) {
      this.requestAttempts = this.requestRetryCarried ? this.requestAttempts + 1 : 1;
      this.requestRetryCarried = false;
      this.ensureTurnModel(`${model.provider}/${model.id}`);
    }
    this.attemptStartMono = attemptStartMono;
    this.attemptResponseMono = null;
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
        // HTTP response headers are capture metadata only. The speed window opens on the dialect's `start`
        // stream event (see timeStreamEvent), which is the one signal every transport emits.
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
    if (event.type === 'start') {
      // `start` is PI's contractual "the provider accepted this request and its response stream has
      // begun": no update and no terminal may precede it. Every HTTP dialect pushes it in the same tick
      // as the accepted response headers, so the measured window is unchanged for them. The Codex
      // WebSocket transport has no HTTP response at all — it emits `start` on the first frame of the
      // response — so the previous onResponse-only window never opened and every ChatGPT generation went
      // unmeasured. Opening the window here keeps ONE rule for all transports instead of an HTTP-only one.
      this.attemptResponseMono = this.mono();
      return;
    }
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

  /** Stamp one successful request sample plus the current turn aggregate. Provider-normalized `usage.output`
   *  is authoritative and already includes reasoning and serialized tool calls. Invalid/missing usage or a
   *  zero timing window contributes nothing and leaves an earlier valid aggregate intact. */
  private stampEffective(message: AssistantMessage, completed: boolean): void {
    const timing = message as AssistantMessage & EffectiveRequestTiming;
    if (completed && this.requestAttempts === 1 && this.attemptFirstContentMs != null) {
      timing.firstContentMs = this.attemptFirstContentMs;
    }
    const output = message.usage?.output ?? 0;
    const elapsedMs = completed && message.stopReason !== 'error' && message.stopReason !== 'aborted'
      && this.attemptResponseMono != null
      ? Math.max(0, this.mono() - this.attemptResponseMono)
      : 0;
    if (speedOf(output, elapsedMs) != null) {
      timing.effectiveTimingVersion = 3;
      timing.effectiveMs = elapsedMs;
      this.turnAggregate = addSpeedSample(this.turnAggregate, { output, elapsedMs });
    }
    // Repeat the aggregate even when THIS successful response was unmeasurable. A tool/status transition
    // without a new valid sample merges with the existing turn instead of clearing its last known speed.
    if (completed && this.turnAggregate.output > 0 && this.turnAggregate.elapsedMs > 0) {
      timing.effectiveTimingVersion = 3;
      timing.effectiveTurnId = this.turnId;
      timing.effectiveModel = this.turnModel;
      timing.effectiveTurnOutput = this.turnAggregate.output;
      timing.effectiveTurnMs = this.turnAggregate.elapsedMs;
    }
    this.publishTurnState(timing.firstContentMs);
    if (completed) this.requestAttempts = 0;
    this.attemptResponseMono = null;
  }

  bindSession(session: AgentSession): void {
    this.boundSession = session;
  }

  private ensureTurnModel(model: string): void {
    if (this.turnModel === model) return;
    if (this.turnModel !== undefined) {
      this.turnId = randomUUID();
      this.turnAggregate = { output: 0, elapsedMs: 0 };
    }
    this.turnModel = model;
    this.publishTurnState();
  }

  private publishTurnState(firstContentMs?: number): void {
    if (!this.boundSession) return;
    effectiveTurns.set(this.boundSession, {
      turnId: this.turnId,
      ...(this.turnModel ? { model: this.turnModel } : {}),
      output: this.turnAggregate.output,
      elapsedMs: this.turnAggregate.elapsedMs,
      ...(firstContentMs != null ? { firstContentMs } : {}),
    });
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
    // Drop only this attempt's timing. A previous valid turn aggregate remains authoritative; request
    // debugger correlation is independent from the provider stream measurement.
    this.attemptResponseMono = null;
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
