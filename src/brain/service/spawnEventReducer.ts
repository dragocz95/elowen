import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { Model, Api } from '@earendil-works/pi-ai';
import { isRetryableAssistantError } from '@earendil-works/pi-ai';
import type { BrainStore } from '../../store/brainStore.js';
import { logger } from '../../shared/logger.js';
import { isErroredContextOverflow, sessionUsageSnapshot, toBrainEvent } from '../events.js';
import { extractText, lastAssistant } from '../messageView.js';
import { abortSessionWork } from '../session/abortSessionWork.js';
import { LiveEventReplay } from '../session/liveEventReplay.js';
import type { LiveBrain, QueuedMsg } from '../session/liveBrain.js';
import {
  clearDeliveredUserEchoes,
  deliverQueuedUserEcho,
  queuedWithPending,
  reconcileMirrors,
  stageDeliveredUserEchoes,
} from '../session/queueMirror.js';
import type { ToolIconResolver } from '../toolIcons.js';

/** PI already classifies and retries transient provider failures. Reuse that same classifier after its
 * retry budget is exhausted so the final transcript never leaks a provider-specific transport or stream
 * error that PI itself treated as temporary.
 *
 * The raw message is logged BEFORE the classifier, unconditionally: a retryable one is about to be masked
 * out of the transcript, so the log is the only place its cause survives. That cause is the point — an
 * aborted outbound request reaches nginx as a bare 499 with no reason attached, and the SDK's own
 * `Request timed out.` is what distinguishes a transport deadline from every other provider failure. */
function publicProviderError(message: string, sessionId: string, provider: string, model: string): string {
  logger('brain-provider').warn(`provider error on ${provider}/${model} (${sessionId}): ${message}`);
  if (!isRetryableAssistantError({ role: 'assistant', stopReason: 'error', errorMessage: message } as never)) return message;
  logger('brain-provider').warn(`provider retries exhausted for ${provider}/${model} (${sessionId})`);
  return 'Provider request failed after automatic retries. Please retry the turn.';
}

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
  return (e: AgentSessionEvent): void => {
    const live = getLive();
    const raw = (e as { type?: string }).type;
    let suppressAgentEndIdle = raw === 'agent_end' && (e as { willRetry?: boolean }).willRetry === true;
    let emitFailedRecoveryIdle = false;
    const agentEndMessages = raw === 'agent_end'
      ? ((e as { messages?: { role?: string; stopReason?: string; errorMessage?: string; content?: unknown; usage?: unknown }[] }).messages ?? [])
      : [];
    const agentEndLastAssistant = lastAssistant(agentEndMessages);
    const agentEndOverflow = !!agentEndLastAssistant && isErroredContextOverflow(agentEndLastAssistant, model.contextWindow);
    // Canonical fallback: PI can settle without a second agent_end when retry backoff is cancelled, or
    // without compaction_end when an overflow has nothing summarizable. Flush the deferred terminal
    // state here so no client remains spinning and a genuine overflow failure is still visible.
    if (raw === 'agent_settled') {
      clearDeliveredUserEchoes(live);
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
        });
        terminalIdleDeferred = false;
      }
      return;
    }
    // Step accounting + ceiling. Each run resets on agent_start; every turn_start is one step. The
    // limit is read fresh per turn (a config change applies without a session restart). Past the
    // ceiling the run is aborted so a wedged agent can't loop forever — it settles into agent_end/idle
    // like a normal stop. `maxSteps ≤ 0` means unlimited (no counter emitted, no enforcement).
    if (raw === 'agent_start') { replay.beginRun(); steps = 0; agentRunOpen = true; }
    else if (raw === 'turn_start') {
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
        replay.publish({ type: 'step', step: steps, maxSteps, usage });
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
      else replay.publish({ type: 'compacted' });
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
        replay.publish({ type: 'compacted' });
        deferredCompacted = false;
      } else if (!recovering && deferredCompacted && !agentRunOpen) {
        replay.publish({ type: 'compacted' });
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
    const be = toBrainEvent(e);
    if (!be) return;
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
    } // statusline data rides the idle event
    if (be.type === 'tool') be.icon = iconOf(be.name);
    replay.publish(be);
    if (emitFailedRecoveryIdle) {
      replay.publish({
        type: 'idle', model: model.id,
        usage: sessionUsageSnapshot(session, store, sessionId),
      });
      terminalIdleDeferred = false;
    }
  };
}
