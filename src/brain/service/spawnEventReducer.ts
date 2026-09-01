import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { Model, Api } from '@earendil-works/pi-ai';
import { isRetryableAssistantError } from '@earendil-works/pi-ai';
import type { BrainStore } from '../../store/brainStore.js';
import { logger } from '../../shared/logger.js';
import { isErroredContextOverflow, sessionUsageSnapshot, toBrainEvent } from '../events.js';
import { extractText, lastAssistant } from '../messageView.js';
import { abortSessionWork } from '../session/abortSessionWork.js';
import { LiveEventReplay } from '../session/liveEventReplay.js';
import { markImagesRejected } from '../session/imageRejection.js';
import type { LiveBrain, QueuedMsg } from '../session/liveBrain.js';
import {
  clearDeliveredUserEchoes,
  deliverQueuedUserEcho,
  queuedWithPending,
  reconcileMirrors,
  stageDeliveredUserEchoes,
} from '../session/queueMirror.js';
import type { ToolIconResolver } from '../toolIcons.js';

/** A PERMANENT provider rejection of an attached image (Anthropic answers `400 invalid_request_error`
 * with "Could not process image" for an undecodable one, and similarly for an oversized one). Anchored on
 * both halves on purpose: `invalid_request_error` keeps transient failures out, and the word `image`
 * keeps every other permanent rejection out. A false positive costs only the images in one conversation's
 * egress context — recoverable, and they can be re-read with a tool — while a false negative leaves that
 * conversation failing every turn forever, so the balance deliberately favours acting. */
function isImageRejection(message: string): boolean {
  return /invalid_request_error/.test(message) && /\bimage\b/i.test(message);
}

/** PI already classifies and retries transient provider failures. Reuse that same classifier after its
 * retry budget is exhausted so the final transcript never leaks a provider-specific transport or stream
 * error that PI itself treated as temporary.
 *
 * The raw message is logged BEFORE the classifier, unconditionally: a retryable one is about to be masked
 * out of the transcript, so the log is the only place its cause survives. That cause is the point — an
 * aborted outbound request reaches nginx as a bare 499 with no reason attached, and the SDK's own
 * `Request timed out.` is what distinguishes a transport deadline from every other provider failure.
 *
 * A refused IMAGE is handled before that classifier because it is not just this turn's failure: the image
 * sits in the live session's history and goes out again with every later request, so without the mark the
 * conversation answers the same 400 forever. Marking it makes the egress stripper drop it on the next
 * request, which is why the text tells the user to simply send again. */
function publicProviderError(message: string, sessionId: string, provider: string, model: string): string {
  logger('brain-provider').warn(`provider error on ${provider}/${model} (${sessionId}): ${message}`);
  if (isImageRejection(message)) {
    markImagesRejected(sessionId);
    logger('brain-provider').warn(`image refused by ${provider}/${model} (${sessionId}) — dropping this conversation's historical images from the next request`);
    return 'The provider could not process an attached image. It has been dropped from this conversation\'s context — send your message again to continue.';
  }
  if (!isRetryableAssistantError({ role: 'assistant', stopReason: 'error', errorMessage: message } as never)) return message;
  logger('brain-provider').warn(`provider retries exhausted for ${provider}/${model} (${sessionId})`);
  // A read deadline deserves its own wording, because its cause is often on THIS side: when the daemon's
  // event loop is saturated the response never gets read in time, and the generic text sends the reader
  // to the provider's status page instead of to the load they just started. `/health` reports the
  // event-loop percentiles that settle which of the two it was.
  if (/request timed out/i.test(message)) {
    return 'The provider request passed its read deadline, and the automatic retries did not help. That is usually a slow provider — but heavy local load can starve the connection too, so check the daemon\'s event-loop lag if a lot of work was running.';
  }
  return 'Provider request failed after automatic retries. Please retry the turn.';
}

/** BrainEvent types that count as the turn actually producing output — the signal that flips a just-sent
 *  user turn from "discardable on Esc" to "keep, only abort the run". Deliberately excludes
 *  user/idle/step/queue/session-event/card and the like: those are not the model doing work. Only events
 *  this reducer actually publishes belong here (they pass through `toBrainEvent`); `subagent`/`workflow`
 *  are emitted directly via emitSubagent/emitWorkflow and never reach this seam, and the Delegate/Workflow
 *  tool CALL that starts them is itself a `tool` event, which already sets the flag. */
const TURN_OUTPUT_EVENTS = new Set<string>(['text', 'reasoning', 'tool', 'tool_authoring', 'diff', 'tool_output']);

/** Every local the spawner's `session.subscribe` callback captured, threaded explicitly so the reducer's
 * behavior stays byte-for-byte identical to the inline closure. `getLive` is a thunk because the
 * spawner assigns `live` AFTER subscribing (events only fire once the session is running, by which point
 * it is set) — exactly the deferred capture the closure relied on. */
export interface SpawnEventReducerDeps {
  replay: LiveEventReplay;
  /** Resolve the LiveBrain — assigned after subscribe(); always defined by the time any event fires. */
  getLive: () => LiveBrain;
  model: Model<Api>;
  sessionId: string;
  session: AgentSession;
  store: BrainStore;
  providerId: string | undefined;
  iconOf: ToolIconResolver;
  queuedSteer: QueuedMsg[];
  queuedFollowUp: QueuedMsg[];
  maxSteps?: () => number;
  /** Where a previewed tool image is stored, so the live `image` event can name a file the reload path
   *  writes too. Absent on an in-memory store; the preview is then skipped rather than faked. */
  chatImagesDir?: string;
}

/** The spawner's stateful event reducer, extracted verbatim from `LiveSessionSpawner.spawn`'s
 *  `session.subscribe(...)` callback. It projects raw PI `AgentSessionEvent`s into the store and fans the
 *  stable `BrainEvent` contract to attached clients, coordinating the deferred terminal state
 *  (`deferredOverflowError`, `terminalIdleDeferred`, `steps`, `agentRunOpen`, `deferredCompacted`) across
 *  the agent_start/message/agent_end(overflow, willRetry)/compaction/agent_settled/auto_retry sequences.
 *  The factory owns the reducer's private state so each spawned session gets its own instance. */
export function createSpawnEventReducer(deps: SpawnEventReducerDeps): (e: AgentSessionEvent) => void {
  const { replay, getLive, model, sessionId, session, store, providerId, iconOf, queuedSteer, queuedFollowUp } = deps;
  // PI decides overflow compact-and-retry only after emitting the errored agent_end. Hold that error
  // until compaction_end tells us whether recovery really failed; otherwise headless clients would
  // exit 1 while the same turn was already compacting and about to succeed.
  let deferredOverflowError: string | null = null;
  let terminalIdleDeferred = false;
  let steps = 0; // model round-trips in the current run — reset on agent_start, one per turn_start
  let agentRunOpen = false;
  let deferredCompacted = false;
  let turnStartedAt: number | undefined;
  let settledDurationMs: number | undefined;
  let settledCompletedAt: string | undefined;
  // One picture, one appearance. `ShareImage` with `latest: true` re-shares the very file a Read preview
  // has already put on screen, and without this the conversation would show the same image twice. Keyed on
  // the ref, whose file name IS the bytes' own sha256 — never on a file name the model chose, which two
  // different pictures may share. `messageView` applies the same first-occurrence-wins rule when it
  // rebuilds the transcript, so a reload shows what the live stream showed.
  const shownImages = new Set<string>();
  return (e: AgentSessionEvent): void => {
    const live = getLive();
    const raw = (e as { type?: string }).type;
    // Retry/overflow agent_end is intermediate; every ordinary terminal agent_end keeps the established
    // lifecycle contract and publishes idle immediately. `agent_settled` remains only the fallback for PI
    // paths that genuinely produce no terminal agent_end (for example cancelled retry backoff).
    let suppressAgentEndIdle = raw === 'agent_end' && (e as { willRetry?: boolean }).willRetry === true;
    let emitFailedRecoveryIdle = false;
    // A REAL compaction has settled: attached clients refetch the shrunk transcript. The model-facing
    // half is deliberately NOT armed here — it is derived from the compaction divider row on the next
    // turn instead, because `live` is not reliably resolvable at this moment and a flag set here would
    // sometimes be written to nothing (see continuity/postCompactionContext.drainPostCompactionContext).
    const announceCompacted = (): void => { replay.publish({ type: 'compacted' }); };
    const agentEndMessages = raw === 'agent_end'
      ? ((e as { messages?: { role?: string; stopReason?: string; errorMessage?: string; content?: unknown; usage?: unknown }[] }).messages ?? [])
      : [];
    const agentEndLastAssistant = lastAssistant(agentEndMessages);
    const agentEndOverflow = !!agentEndLastAssistant && isErroredContextOverflow(agentEndLastAssistant, model.contextWindow);
    if (raw === 'agent_end' || raw === 'agent_settled' || raw === 'compaction_end') {
      const timed = e as AgentSessionEvent & { turnDurationMs?: number; turnCompletedAt?: string };
      settledDurationMs = timed.turnDurationMs ?? settledDurationMs;
      settledCompletedAt = timed.turnCompletedAt ?? settledCompletedAt;
    }
    // Canonical fallback: PI can settle without a second agent_end when retry backoff is cancelled, or
    // without compaction_end when an overflow has nothing summarizable. Flush the deferred terminal
    // state here so no client remains spinning and a genuine overflow failure is still visible.
    if (raw === 'agent_settled') {
      clearDeliveredUserEchoes(live);
      live.lastAdmitted = undefined; // turn settled — a later cancel with no new turn must not discard it
      agentRunOpen = false;
      if (deferredCompacted && deferredOverflowError) {
        replay.publish({ type: 'compacted' });
        deferredCompacted = false;
      }
      if (deferredOverflowError) {
        replay.publish({ type: 'error', message: deferredOverflowError });
        deferredOverflowError = null;
        terminalIdleDeferred = true;
      }
      if (terminalIdleDeferred) {
        replay.publish({
          type: 'idle', model: model.id,
          usage: sessionUsageSnapshot(session, store, sessionId),
          ...(settledDurationMs != null ? { durationMs: settledDurationMs } : {}),
          ...(settledCompletedAt ? { completedAt: settledCompletedAt } : {}),
        });
        terminalIdleDeferred = false;
      }
      return;
    }
    // Step accounting + ceiling. Each run resets on agent_start; every turn_start is one step. The
    // limit is read fresh per turn (a config change applies without a session restart). Past the
    // ceiling the run is aborted so a wedged agent can't loop forever — it settles into agent_end/idle
    // like a normal stop. `maxSteps ≤ 0` means unlimited (no counter emitted, no enforcement).
    if (raw === 'agent_start') {
      replay.beginRun(); steps = 0; agentRunOpen = true;
      turnStartedAt = (e as AgentSessionEvent & { turnStartedAt?: number }).turnStartedAt;
    } else if (raw === 'turn_start') {
      steps += 1;
      const maxSteps = deps.maxSteps?.() ?? 0;
      if (maxSteps > 0 && steps > maxSteps) {
        // The abort below is indistinguishable from every other cause once it leaves the process: it
        // cancels the in-flight request, which the proxy in front of the provider logs as a bare client
        // disconnect. This line is the only place that says the ceiling is what did it.
        logger('brain-step-ceiling').warn(`session ${sessionId} hit the step ceiling (${steps} > ${maxSteps}); aborting the run`);
        void abortSessionWork(session).catch(() => { /* already settling */ });
      } else {
        const usage = sessionUsageSnapshot(session, store, sessionId);
        replay.publish({ type: 'step', step: steps, maxSteps, usage, ...(steps === 1 && turnStartedAt != null ? { turnStartedAt } : {}) });
      }
    }
    if (suppressAgentEndIdle) terminalIdleDeferred = true;
    // BrainSessionFactory subscribed before this spawner and persists `agent_end` synchronously. At
    // this exact boundary the journal is redundant with SQLite, so clear it before terminal events.
    if (raw === 'agent_end') {
      agentRunOpen = false;
      replay.settleRun();
      // The factory listener runs first: a between-tool-turn compaction is persisted only after this
      // agent_end made its current assistant/tool rows durable. Notify/refetch after that atomic rewrite.
      if (deferredCompacted && !agentEndOverflow) {
        replay.publish({ type: 'compacted' });
        deferredCompacted = false;
      }
    }
    // A turn that settled on a provider error (stopReason 'error', no text) would otherwise wind down
    // as a bare idle — the web/CLI client shows NOTHING and the failure is invisible (the silent-reply
    // bug). Surface the provider's message as an error event ahead of the terminal idle. NOT when PI is
    // about to auto-retry (`willRetry`): a transient 429/5xx emits an errored agent_end per attempt, and
    // a premature error event would fail a headless run (exit 1) that the retry was about to rescue.
    if (raw === 'agent_end' && !(e as { willRetry?: boolean }).willRetry) {
      const last = agentEndLastAssistant;
      const text = Array.isArray(last?.content)
        ? (last.content as { type?: string; text?: string }[]).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
        : '';
      if (last?.stopReason === 'error' && !text.trim()) {
        const rawMessage = last.errorMessage?.trim() || 'the model returned no reply (provider error)';
        if (isErroredContextOverflow(last, model.contextWindow)) {
          deferredOverflowError = rawMessage;
          suppressAgentEndIdle = true;
        } else {
          const message = publicProviderError(rawMessage, sessionId, providerId ?? model.provider, model.id);
          replay.publish({ type: 'error', message });
        }
      }
    }
    // A PI compaction just settled (auto at the threshold, manual /compact, overflow recovery): the
    // factory's own subscription has already mirrored the shrunk context into the store (it runs FIRST,
    // subscribed during create()), so tell attached clients to refetch history and collapse. Only a REAL
    // compaction (result present, not aborted) — a no-op/failed run leaves the transcript as-is.
    if (raw === 'compaction_end' && (e as { result?: unknown }).result != null && (e as { aborted?: boolean }).aborted !== true) {
      if (agentRunOpen || deferredCompacted) deferredCompacted = true;
      else announceCompacted();
    }
    if (raw === 'compaction_end' && (e as { reason?: string }).reason === 'overflow') {
      const ce = e as { result?: unknown; aborted?: boolean; willRetry?: boolean; errorMessage?: string };
      const recovering = ce.result != null && ce.aborted !== true && ce.willRetry === true;
      if (recovering) deferredOverflowError = null;
      else if (deferredOverflowError) {
        replay.publish({ type: 'error', message: ce.errorMessage?.trim() || deferredOverflowError });
        deferredOverflowError = null;
        emitFailedRecoveryIdle = true;
      }
      // A previous successful between-turn compaction waited for this overflow outcome. On failure the
      // factory just persisted the deferred run and applied that pending rewrite; refetch only now.
      if (recovering && deferredCompacted && !agentRunOpen) {
        // The factory listener just persisted the deferred current-run prefix and atomically replaced
        // its earlier threshold summary with this overflow summary. Refetch now; the retry's later
        // agent_end contains only the recovered assistant and must not emit a duplicate refresh.
        announceCompacted();
        deferredCompacted = false;
      } else if (!recovering && deferredCompacted && !agentRunOpen) {
        announceCompacted();
        deferredCompacted = false;
      }
    }
    // Keep the image-carrying queue mirror aligned with PI's native queue on every enqueue/delivery/clear.
    if (raw === 'queue_update') {
      const qe = e as { steering?: readonly string[]; followUp?: readonly string[] };
      const removed = reconcileMirrors(queuedSteer, queuedFollowUp, qe.steering ?? [], qe.followUp ?? []);
      stageDeliveredUserEchoes(live, removed);
    }
    // PI emits queue_update (with the delivered item removed) immediately before this event. Project
    // the clean durable row and its user bubble at that exact boundary — never while it is still a chip.
    if (raw === 'message_start' && (e as { message?: { role?: string } }).message?.role === 'user') {
      const message = (e as unknown as { message: Parameters<typeof extractText>[0] }).message;
      deliverQueuedUserEcho(store, live, extractText(message));
    }
    const be = toBrainEvent(e, Date.now(), deps.chatImagesDir);
    if (!be) return;
    if (be.type === 'image') {
      if (shownImages.has(be.ref)) return;
      shownImages.add(be.ref);
    }
    if (be.type === 'queue') {
      // Image-carrying mirrors are the display source (PI's queue_update text is post-expansion); prepend
      // any message waiting under a manual /compact so a PI queue_update in that window can't hide its chip.
      be.items = queuedWithPending(getLive());
    }
    // PI emits this intermediate agent_end before ordinary retry / overflow recovery. It is not a
    // terminal idle: headless must keep waiting and interactive clients must keep their spinner alive.
    if (suppressAgentEndIdle && be.type === 'idle') return;
    if (be.type === 'idle') {
      be.usage = sessionUsageSnapshot(session, store, sessionId);
      be.model = model.id;
      terminalIdleDeferred = false;
      live.lastAdmitted = undefined; // turn settled — a later cancel with no new turn must not discard it
    } // statusline data rides the idle event
    if (be.type === 'tool') be.icon = iconOf(be.name);
    // First real output of the turn (see LiveBrain.turnProducedOutput): once set, a cancel keeps the turn
    // instead of discarding it. And if abort() has already decided synchronously to discard this turn, drop
    // a content event still in flight from PI — the cancel won the first-token race, its bubble is gone.
    if (TURN_OUTPUT_EVENTS.has(be.type)) {
      if (live.discardingUserTurn) return;
      live.turnProducedOutput = true;
    }
    replay.publish(be);
    if (emitFailedRecoveryIdle) {
      replay.publish({
        type: 'idle', model: model.id,
        usage: sessionUsageSnapshot(session, store, sessionId),
        ...(settledDurationMs != null ? { durationMs: settledDurationMs } : {}),
        ...(settledCompletedAt ? { completedAt: settledCompletedAt } : {}),
      });
      terminalIdleDeferred = false;
    }
  };
}
