import { sendLockKey } from '../session/liveRegistry.js';
import type { KnownControls } from '../../plugins/api.js';
import type { PluginRegistry } from '../../plugins/registry.js';
import type { ToolPolicy } from '../../plugins/policyContext.js';
import type { HookAuditBuffer } from '../../shared/hookAudit.js';
import type { BrainStore } from '../../store/brainStore.js';
import type { BrainSubagentResult } from '../../store/brainDelegationStore.js';
import type { MemoryService } from '../memoryService.js';
import type { MemoryCurator } from '../memoryCurator.js';
import type { ConversationTitler } from '../conversationTitler.js';
import type { ElicitationRegistry } from '../elicitation.js';
import type { CardRegistry } from '../cards.js';
import type { IdentityResolver } from '../identity.js';
import { extractText, isThinkingOnlyReply, NO_REPLY_NUDGE, lastAssistant } from '../messageView.js';
import { newCostMeter, runWithMeter } from '../openrouterMeter.js';
import type { LiveSessionRegistry } from '../session/liveRegistry.js';
import type { LiveBrain } from '../session/liveBrain.js';
import type { BrainDeps } from '../brainDeps.js';
import type { ConversationLifecycle } from './lifecycle.js';
import type { GoalLoopService } from './goalLoop.js';
import type { PermissionApprovalService } from './permissionApproval.js';
import { TurnAdmission } from './turnAdmission.js';
import { TurnContextBuilder } from './turnContextBuilder.js';
import { flushReasoningMarker, recordSessionEvent } from './sessionEvents.js';
import type { TurnImage, TurnMode, TurnRequest } from './turnRequest.js';
import { hasActiveNativeCompactionCheck } from '../session/compactionCheckCoordinator.js';
import { queuedWithPending } from '../session/queueMirror.js';
import { cacheTtlMs } from '../session/cacheTiming.js';
import { maybeColdStartCompaction, type ColdStartCompactionDeps } from '../session/coldStartCompaction.js';
import { openTurn, settleTurn, type TurnActivityFeed, type TurnOriginPin } from '../session/turnSettled.js';
import type { SubagentCompletion, WorkflowCompletion } from '../events.js';
import { randomUUID } from 'node:crypto';
import { isNonUserSession } from '../sessionId.js';
import { xmlEscape } from '../../shared/xml.js';
import { logger } from '../../shared/logger.js';
import { steerCustomMessage } from '../session/steerCustomMessage.js';
import { conversationActivitySurface, resetConversationActivity } from '../session/conversationActivity.js';
import type { ConversationActivitySurface } from '../session/conversationActivity.js';
import { continuable, continueInterruptedTurn } from '../session/continueTurn.js';


/** A durable sub-agent result is retried at most this many times before the drain gives up (leaves the
 *  row pending, no further timer). A later user turn on the parent re-triggers one more attempt. */
const MAX_RESULT_DELIVERY_ATTEMPTS = 5;

/** A message carrying our result id, as it appears in a live PI transcript. */
type CustomResultMessage = { role?: string; details?: { resultId?: string } };

/** How far a hidden custom message got.
 *  `landed`  — it is provably in the parent's context (or went through a delegated parent's own verified
 *              turn), so the durable row may be acknowledged.
 *  `steered` — PI accepted it into the RUNNING turn's steering queue and will inject it before that turn's
 *              next model call. Not yet provable: a stop that clears PI's queue in between would erase it,
 *              so the row stays pending until a later drain SEES it in the transcript. */
type CustomDelivery = 'landed' | 'landed-unanswered' | 'steered';

export interface PendingResultDrainOutcome {
  answered: boolean;
  /** At least one unsafe-recovery notice was persisted without starting an autonomous parent turn. */
  requiresUserAction: boolean;
  acknowledged: { id: string; toolCallId: string; kind: 'subagent' | 'workflow' }[];
  deliveredPending: { id: string; toolCallId: string; kind: 'subagent' | 'workflow' }[];
}

/** Is this result's hidden custom message already in the session's live context? It carries our result id,
 *  so its presence is the only honest answer to "did this land?", whatever became of the turn that was
 *  supposed to carry it. An id-less delivery matches our own id-less custom message, which is what the
 *  caller wants: it has no other handle on the thing it just sent. */
function resultInContext(messages: readonly CustomResultMessage[], resultId: string | undefined): boolean {
  return messages.some((message) => message.role === 'custom' && message.details?.resultId === resultId);
}

/** An unsafe-recovery notice is consumed only by a later user message in the same live context. A boot-only
 * custom append has no such message, so the durable inbox row remains the restart-safe gate. */
function resultFollowedByUser(messages: readonly CustomResultMessage[], resultId: string): boolean {
  const notice = messages.findIndex((message) => message.role === 'custom' && message.details?.resultId === resultId);
  return notice >= 0 && messages.slice(notice + 1).some((message) => message.role === 'user');
}

interface TurnRunnerDeps {
  store: BrainStore;
  /** The shared live-session state (owned by the BrainService facade). */
  sessions: LiveSessionRegistry<LiveBrain>;
  lifecycle: ConversationLifecycle;
  /** False once the daemon is draining for shutdown: a NEW turn is refused so the drain can converge,
   *  while an interrupted-turn resume still runs. Delegation and result delivery never reach `send`, so
   *  they are unaffected. Absent ⇒ always admits (test doubles that do not wire shutdown). */
  admitsNewWork?(): boolean;
  goals: GoalLoopService;
  permissions: PermissionApprovalService;
  elicitation: ElicitationRegistry;
  cards: CardRegistry;
  /** The ONE place turn identities (and the owner check) are minted. */
  identity: IdentityResolver;
  /** Names a brand-new conversation from its first message — see BrainService. */
  titler: ConversationTitler;
  /** Where a turn's attachments are written so they outlive it (undefined for an in-memory database). */
  chatImagesDir?: string;
  /** Post-turn memory curator — present only when the memory deps are wired. */
  curator?: MemoryCurator;
  prompts: BrainDeps['prompts'];
  users: BrainDeps['users'];
  userSettings?: BrainDeps['userSettings'];
  memoryService?: MemoryService;
  memoryCategoryStore?: BrainDeps['memoryCategoryStore'];
  projects?: BrainDeps['projects'];
  sandbox?(): KnownControls['sandbox'] | undefined;
  /** The daemon-wide plugin registry (undefined when plugins aren't wired at all). */
  plugins(): Promise<PluginRegistry | undefined>;
  /** What a user may reach: the grant an admin gave that account, minus their `disabled_tools` and the
   *  tools of any per-user-granted plugin they do not hold. Resolved by the facade, which is the only
   *  layer holding the registry synchronously. Absent (test doubles) → nothing is restricted. */
  toolAuthorityFor?(userId: number): ToolPolicy | undefined;
  hookAudit?: HookAuditBuffer;
  projectPath?: () => string | undefined;
  sendDelegatedCustom?(userId: number, sessionId: string, customType: string, content: string, resultId: string): Promise<void>;
  /** Apply a plugin reload a tool requested mid-turn, once the send lock is released — see
   *  {@link settleTurn}. The channel service is handed the same callback. */
  drainPluginReload?(): void;
  /** Tell the user their turn is done on a device that is not showing it. Owner-only by nature, so a
   *  channel turn simply does not pass it. `userInitiated` is false only for an internal goal/nudge turn;
   *  whether the answer is being READ is a separate question, answered from `senderClientId` — the
   *  surface it came from — so a bound CLI qualifies here and is kept quiet by still being on screen. */
  notifyTurnComplete?(userId: number, sessionId: string, userInitiated: boolean, senderClientId?: string): void;
  /** The write-time origin rollup, so a turn's spend is attributed to the address that ordered it. */
  usageOrigins?: TurnOriginPin;
  /** The team activity feed. Absent on a minimal wiring, which then simply has no feed. */
  recordActivity?: TurnActivityFeed;
  /** Notify user-scoped conversation-list subscribers after durable activity changes. */
  onConversationActivityChanged?: (sessionId: string) => void;
}

/** The owner-chat turn pipeline: mid-run steering, idle rollover + vision hop (delegated to the
 *  lifecycle), the live-prompt assembly (memory/hook/permissions blocks + turn context), the
 *  runWithPolicy scope with its turn-bound emitters, the thinking-only nudge, the post-turn curator
 *  kickoff, auto-compact and the goal judge. */
/** The system reminder that carries ONE durable delegated result into its parent's context — the shape a
 *  parent's model reads for a background sub-agent, a boot-recovered child, or a workflow. Exported so the
 *  platform resume can deliver the same block as a room's continuation. */
export function subagentResultReminder(result: BrainSubagentResult): string {
  return result.kind === 'workflow'
    // A workflow delivers one whole-DAG summary body (which itself names each node's outcome), so
    // it rides a <workflow-result> block rather than the sub-agent <result>/<error> split.
    ? '<system-reminder>\n'
      + `<workflow-result id="${xmlEscape(result.id)}" status="${result.status}">\n`
      + `<task>${xmlEscape(result.task)}</task>\n<result>${xmlEscape(result.result ?? '(the workflow returned nothing)')}</result>\n</workflow-result>\n`
      + '<instruction>A background workflow finished. Incorporate this result into your current work. '
      + 'The node transcripts remain available separately; do not claim their internal tool calls as your own.</instruction>\n'
      + '</system-reminder>'
    : '<system-reminder>\n'
      + `<subagent-result id="${xmlEscape(result.id)}" session="${xmlEscape(result.sessionId)}" status="${result.status}">\n`
      + `<task>${xmlEscape(result.task)}</task>\n`
      + `${result.status === 'done'
        ? `<result>${xmlEscape(result.result ?? '(the sub-agent returned nothing)')}</result>`
        : `<error>${xmlEscape(result.error ?? 'unknown sub-agent error')}</error>`}\n</subagent-result>\n`
      + '<instruction>A background sub-agent finished. Incorporate this result into your current work. '
      + 'The child transcript remains available separately; do not claim its internal tool calls as your own.</instruction>\n'
      + '</system-reminder>';
}

export class BrainTurnRunner {
  private contextBuilder: TurnContextBuilder;
  /** One shared promise per parent: overlapping wake paths join the same delivery instead of silently
   * returning while the only drain that can wake the conversation is still in flight. */
  private readonly resultDrains = new Map<string, {
    promise: Promise<PendingResultDrainOutcome>;
    state: { deferUnanswered: boolean };
  }>();
  private readonly resultRetryTimers = new Map<string, NodeJS.Timeout>();
  /** Boot-claimed owner wakes require a settled answer even if an ordinary start() drain wins the race. */
  private readonly settledResultParents = new Set<string>();
  private readonly settledResultOutcomes = new Map<string, PendingResultDrainOutcome>();
  /** Results steered into a still-running turn, per parent session: handed to PI but not yet visible in
   *  the transcript. A steered row stays pending on purpose (PI's queue can still be cleared by a stop),
   *  so the next drain would otherwise re-send it and the model would read the same result twice. The
   *  transcript check alone cannot see this window. Cleared the moment the turn is no longer streaming,
   *  because PI's queue does not survive it — from then on the transcript is the only truth, and holding
   *  an id back any longer would strand a result instead of merely duplicating it. */
  private readonly steeredInFlight = new Map<string, Set<string>>();

  constructor(private d: TurnRunnerDeps) {
    this.contextBuilder = new TurnContextBuilder({
      ...d,
      completeSubagent: (parentSessionId, userId, completion) => {
        this.acceptSubagentCompletion(parentSessionId, userId, completion);
      },
      completeWorkflow: (parentSessionId, userId, completion) => {
        this.acceptWorkflowCompletion(parentSessionId, userId, completion);
      },
    });
  }

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.d.sessions.withLock(key, fn);
  }

  /** Deliver host-owned lifecycle information through PI's native hidden custom-message seam. `display:false`
   * keeps it out of the user transcript either way; how it gets in depends on the parent.
   *
   * IDLE parent — take the conversation lock and normally let `triggerTurn` run a turn on it, so the agent
   * reacts now. An unsafe-recovery notice passes `triggerTurn=false`: it must enter the durable context but
   * wait for the user's next turn, because the interrupted request still in history could otherwise replay.
   *
   * STREAMING parent — STEER it into the running turn. PI injects a steering message into the context before
   * that turn's next model call, so a background result reaches the agent during the work it belongs to
   * instead of a whole turn later. Delivery is not confirmed here (see `CustomDelivery`). */
  /** Continue an owner conversation's interrupted turn from its transcript tail — no message of any kind
   *  (session/continueTurn.ts). The boot resume of a paused turn: the checkpointed tail already ends on
   *  the answers to the interrupted calls, so the model simply takes its next step. Same locks and turn
   *  scope as a hidden system turn. `nothing` when the transcript ends on an assistant message (the turn
   *  had in fact finished; there is nothing to continue). Throws when the continuation ran but no fresh,
   *  normally settled assistant came out of it. */
  async continueInterrupted(userId: number, session: string): Promise<'continued' | 'nothing'> {
    const target = this.d.lifecycle.ownedUserSession(userId, session);
    if (!this.d.sessions.get(target)) await this.d.lifecycle.ensureLive(userId, target);
    return this.serial(sendLockKey(target), () => this.serial(target, async (): Promise<'continued' | 'nothing'> => {
      const live = this.d.sessions.get(target);
      if (!live) throw new Error('brain not started for user');
      if (live.session.isStreaming) throw new Error('cannot continue a turn that is already running');
      const messages = live.session.messages as { role?: string; stopReason?: string; errorMessage?: string }[];
      // An unfinished trailing assistant is trimmed by the continuation; count from the message before it.
      const before = messages.length - (continuable(messages) ? 0 : 1);
      const context = this.contextBuilder.buildScope(userId, live);
      const outcome = await context.run(() => continueInterruptedTurn(live.session, { store: this.d.store, sessionId: target }));
      if (outcome === 'nothing') return 'nothing';
      const settled = lastAssistant((live.session.messages as typeof messages).slice(before));
      if (!settled || settled.stopReason === 'aborted' || settled.stopReason === 'error') {
        throw new Error(settled?.errorMessage?.trim() || `the continuation ${settled?.stopReason ?? 'produced no assistant reply'}`);
      }
      return 'continued';
    }));
  }

  async sendCustomSystem(
    userId: number,
    session: string,
    customType: string,
    content: string,
    resultId?: string,
    triggerTurn = true,
  ): Promise<CustomDelivery> {
    if (isNonUserSession(session)) {
      if (!resultId || !this.d.sendDelegatedCustom) throw new Error('delegated result delivery unavailable');
      await this.d.sendDelegatedCustom(userId, session, customType, content, resultId);
      return 'landed';
    }
    const target = this.d.lifecycle.ownedUserSession(userId, session);
    if (!this.d.sessions.get(target)) await this.d.lifecycle.ensureLive(userId, target);
    const message = {
      customType,
      content,
      display: false,
      details: { source: 'elowen', ...(resultId ? { resultId } : {}) },
    };
    const running = this.d.sessions.get(target);
    if (!running) throw new Error('brain not started for user');
    if (running.session.isStreaming) {
      // Deliberately OUTSIDE the send/session locks: the turn we are steering into is the one holding them,
      // so taking them would mean waiting for exactly the turn we want to reach — which is the behaviour
      // this path replaces. Same reasoning as ChannelService.trySteerIntoRunningTurn.
      if (resultId && resultInContext(running.session.messages as CustomResultMessage[], resultId)) return 'landed-unanswered';
      // Already handed to PI by an earlier drain and still queued (see steeredInFlight). Two children
      // finishing close together is the ordinary case under fan-out, not a rare race.
      if (resultId && this.steeredInFlight.get(target)?.has(resultId)) return 'steered';
      // Enqueued on PI's steering queue rather than sent, which closes the one race the isStreaming read
      // above cannot: were the turn to end in between, sending would start a whole turn from here, outside
      // the lock that serializes prompts on this session. See steerCustomMessage for why the flag that
      // used to express this no longer does.
      steerCustomMessage(running.session, message);
      if (resultId) {
        const queued = this.steeredInFlight.get(target) ?? new Set<string>();
        queued.add(resultId);
        this.steeredInFlight.set(target, queued);
      }
      return 'steered';
    }

    // The bare session lock (inner) is nested under the outer `send-` lock, matching a user turn's own
    // ordering (send-<id> → <id>), so this never deadlocks against a concurrent send()/compact/stop.
    return this.serial(sendLockKey(target), () => this.serial(target, async (): Promise<CustomDelivery> => {
      const live = this.d.sessions.get(target);
      if (!live) throw new Error('brain not started for user');
      // An earlier steer that landed while we queued behind that turn is already in the context. Sending a
      // second copy is the one failure mode this whole durable pipeline must not produce. It did not produce
      // a fresh answer in THIS delivery, which matters to a genuinely parked owner turn.
      if (resultId && resultInContext(live.session.messages as CustomResultMessage[], resultId)) return 'landed-unanswered';
      const before = lastAssistant(live.session.messages as { role?: string }[]);
      const ownerActivity = triggerTurn && !isNonUserSession(target);
      const currentActivity = ownerActivity ? this.d.store.getSessionActivity(target) : undefined;
      const existingActivityTurnId = currentActivity?.state === 'working' ? currentActivity.turnId : null;
      const activityTurnId = existingActivityTurnId ?? randomUUID();
      const activitySurface = conversationActivitySurface(
        undefined, currentActivity?.webParticipatedAt != null ? 'web' : 'cli');
      const activityStarted = ownerActivity && existingActivityTurnId === null;
      const opened = openTurn({
        sessionId: target,
        ...(activityStarted
          ? { conversationActivity: { store: this.d.store, turnId: activityTurnId, surface: activitySurface, onChanged: this.d.onConversationActivityChanged } }
          : {}),
      });
      let activityState: 'done' | 'failed' = 'failed';
      let activityDetail: string | undefined;
      try {
        const context = this.contextBuilder.buildScope(userId, live);
        await context.run(() => live.session.sendCustomMessage(message, { triggerTurn, deliverAs: 'followUp' }));
        if (!triggerTurn) return 'landed-unanswered';
        const settled = lastAssistant(live.session.messages as { role?: string; stopReason?: string; errorMessage?: string }[]);
        // A turn that did not settle normally is NOT automatically a failure to deliver: PI appends the
        // custom message to the transcript before running the turn, so the result may already be in the
        // parent's context, and re-delivering it would put it there twice. Don't assume from the turn's
        // shape — look for the message.
        const landed = resultInContext(live.session.messages as CustomResultMessage[], resultId);
        // No new assistant at all. Usually a genuine non-delivery — but PI strips the errored assistant out
        // of live state BEFORE its retry backoff, so a retry the user cancels mid-sleep settles with the
        // pre-delivery assistant still last, having already put the result in context.
        if (!settled || settled === before) {
          if (!landed) throw new Error('sub-agent result was not processed by the parent model');
          logger('brain-subagent').info(`sub-agent result for ${target} entered the context of a cancelled parent retry; acknowledging without retry`);
          return 'landed-unanswered';
        }
        // Two ways to get here. The user aborted the turn mid-flight (Esc / stop). Or the parent's own model
        // turn errored — which says nothing about the CHILD's result: the delivery budget exists for a
        // transport that could not carry it, and spending it on the parent's provider outage is what burns
        // all five attempts in half a minute and strands a perfectly good result.
        if (settled.stopReason === 'aborted' || settled.stopReason === 'error') {
          const why = settled.stopReason === 'aborted' ? 'aborted' : 'errored';
          if (!landed) throw new Error(settled.errorMessage?.trim() || `parent turn ${why} before the sub-agent result reached its context`);
          logger('brain-subagent').info(`sub-agent result for ${target} entered the context of an ${why} parent turn; acknowledging without retry`);
          return 'landed-unanswered';
        }
        activityState = 'done';
        return 'landed';
      } catch (error) {
        activityDetail = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        if (ownerActivity) {
          settleTurn({
            sessionId: target,
            conversationActivity: {
              store: this.d.store,
              turnId: activityTurnId,
              surface: activitySurface,
              state: activityState,
              ...(activityDetail ? { detail: activityDetail } : {}),
              onChanged: this.d.onConversationActivityChanged,
            },
          });
        }
        opened.close();
      }
    }));
  }

  resultDeliveryWorkCount(): number {
    return this.resultDrains.size + this.resultRetryTimers.size;
  }

  /** Store-first terminal completion ingress shared by explicit background jobs and Ctrl+B detaches. */
  acceptSubagentCompletion(parentSessionId: string, userId: number, completion: SubagentCompletion): void {
    if (!this.d.store.enqueueSubagentResult(parentSessionId, completion)) {
      // The enqueue join needs a live run row AND a parent/child link owned by the same user. Without one
      // the result has nowhere durable to go and the parent is never woken — the work is simply lost, with
      // nothing to distinguish it from a child that never finished. Never silent.
      logger('brain-subagent').error(`dropped sub-agent result for ${parentSessionId} (tool ${completion.toolCallId}, child ${completion.sessionId}): no durable parent/child link`);
      return;
    }
    this.publishResultDelivery(parentSessionId, completion.toolCallId, 'pending');
    void this.drainPendingSubagentResults(userId, parentSessionId);
  }

  /** Terminal completion ingress for a detached/background WORKFLOW. Shares the exact durable inbox and
   *  drain as sub-agent results (one place for retry/backoff/ack); only the enqueue linkage differs (it
   *  validates against brain_workflows, not a child run row). No `publishResultDelivery`: a workflow has
   *  no brain_subagent_runs row to project a delivery marker onto. */
  acceptWorkflowCompletion(parentSessionId: string, userId: number, completion: WorkflowCompletion): void {
    if (!this.d.store.enqueueWorkflowResult(parentSessionId, completion)) {
      logger('brain-subagent').error(`dropped workflow result for ${parentSessionId} (tool ${completion.toolCallId}, workflow ${completion.id}): no durable workflow link`);
      return;
    }
    void this.drainPendingSubagentResults(userId, parentSessionId);
  }

  requireSettledResultDelivery(parentSessionId: string): void {
    this.settledResultParents.add(parentSessionId);
  }

  consumeSettledResultOutcome(parentSessionId: string): PendingResultDrainOutcome | undefined {
    const outcome = this.settledResultOutcomes.get(parentSessionId);
    this.settledResultOutcomes.delete(parentSessionId);
    return outcome;
  }

  releaseSettledResultDelivery(parentSessionId: string): void {
    this.settledResultParents.delete(parentSessionId);
    this.settledResultOutcomes.delete(parentSessionId);
  }

  /** Deliver every durable pending result serially after any active owner turn. A failed transport or
   * model turn leaves the row pending and schedules bounded retry; no permanent poller exists. */
  async drainPendingSubagentResults(userId: number, parentSessionId: string, deferUnanswered = false): Promise<PendingResultDrainOutcome> {
    deferUnanswered ||= this.settledResultParents.has(parentSessionId);
    const existing = this.resultDrains.get(parentSessionId);
    if (existing) {
      if (deferUnanswered) existing.state.deferUnanswered = true;
      const first = await existing.promise;
      // A caller may arrive after the active drain's final empty scan but before its promise settles. Its
      // newly enqueued row was not part of that run; once the shared promise cleans up, drain that tail too.
      if (this.d.store.pendingSubagentResults(parentSessionId).length === 0) return first;
      const tail = await this.drainPendingSubagentResults(userId, parentSessionId, deferUnanswered);
      return {
        // A tail result's new answer includes the earlier custom messages already in context; if the tail
        // delivered anything, its answer state supersedes the earlier drain rather than AND-ing with it.
        answered: tail.acknowledged.length + tail.deliveredPending.length > 0 ? tail.answered : first.answered,
        requiresUserAction: first.requiresUserAction || tail.requiresUserAction,
        acknowledged: [...first.acknowledged, ...tail.acknowledged],
        deliveredPending: [...first.deliveredPending, ...tail.deliveredPending],
      };
    }
    // Defer body execution one microtask so the map owns the promise before ensureLive or another nested
    // wake can re-enter this method. The wrapper includes cleanup, so joiners resume only after the map is
    // free for a late-arriving tail drain.
    const state = { deferUnanswered };
    const run = Promise.resolve().then(() => this.runPendingSubagentResultDrain(userId, parentSessionId, state));
    let drain: Promise<PendingResultDrainOutcome>;
    drain = run.then((outcome) => {
      // A stronger boot caller may join after an ordinary drain already acknowledged an unanswered row.
      // Requeue before the shared promise resolves, so continuation delivery never opens a crash-loss gap.
      if (!state.deferUnanswered || outcome.answered || outcome.acknowledged.length === 0) return outcome;
      const deliveredPending = [...outcome.deliveredPending];
      const acknowledged = [] as PendingResultDrainOutcome['acknowledged'];
      for (const result of outcome.acknowledged) {
        if (this.d.store.requeueSubagentResult(parentSessionId, result.id)) deliveredPending.push(result);
        else acknowledged.push(result);
      }
      return { ...outcome, acknowledged, deliveredPending };
    }).then((outcome) => {
      if (this.settledResultParents.has(parentSessionId)) this.settledResultOutcomes.set(parentSessionId, outcome);
      return outcome;
    }).finally(() => {
      if (this.resultDrains.get(parentSessionId)?.promise === drain) this.resultDrains.delete(parentSessionId);
    });
    this.resultDrains.set(parentSessionId, { promise: drain, state });
    return drain;
  }

  private async runPendingSubagentResultDrain(userId: number, parentSessionId: string, state: { deferUnanswered: boolean }): Promise<PendingResultDrainOutcome> {
    let allAnswered = true;
    let requiresUserAction = false;
    const acknowledged: PendingResultDrainOutcome['acknowledged'] = [];
    const deliveredPending: PendingResultDrainOutcome['deliveredPending'] = [];
    // One unsafe-recovery notice makes the whole batch wait for the user's next parent turn. Otherwise a
    // normal completion earlier in the same queue could start a model turn that sees the notice and acts on
    // it autonomously. Delegated parents keep their existing recovery path; this gate is for owner sessions.
    const withholdParentTurn = !isNonUserSession(parentSessionId)
      && this.d.store.pendingSubagentResults(parentSessionId).some((result) => result.requiresUserAction);
    const oldTimer = this.resultRetryTimers.get(parentSessionId);
    if (oldTimer) { clearTimeout(oldTimer); this.resultRetryTimers.delete(parentSessionId); }
    // Each result gets at most one shot per drain, so a poisoned one cannot sit at the head of the queue
    // failing forever and starve everything behind it — the user would silently stop receiving any
    // delegated work at all. It is still retried on the next drain: the cause may be an outage that
    // outlives the timed retries, and the result is only worthless once it is delivered.
    const attempted = new Set<string>();
    while (true) {
      const result = this.d.store.pendingSubagentResults(parentSessionId).find((row) => !attempted.has(row.id));
      if (!result) break;
      attempted.add(result.id);
      const content = subagentResultReminder(result);
      try {
        const delivery = await this.sendCustomSystem(
          userId,
          parentSessionId,
          'subagent-result',
          content,
          result.id,
          !withholdParentTurn,
        );
        if (withholdParentTurn && result.requiresUserAction) requiresUserAction = true;
        // Steered into a running turn: PI holds it, but "PI accepted it" is not "the parent's context has
        // it" — a stop clearing PI's queue in between would erase it. Leave the row pending and move on to
        // the rest of the queue; the post-turn drain finds the message in the transcript and acknowledges
        // it there, or re-delivers it for real. Not a failure: no attempt spent, no retry timer.
        if (delivery === 'steered') continue;
        // A withheld batch deliberately produces no assistant answer. Keep every row pending until an actual
        // user turn consumes the custom message: custom PI entries are live context, not brain_messages, so
        // acknowledging here would lose the only durable copy on another restart or session eviction.
        if (withholdParentTurn) {
          deliveredPending.push({ id: result.id, toolCallId: result.toolCallId, kind: result.kind });
          continue;
        }
        if (delivery === 'landed-unanswered') {
          allAnswered = false;
          if (state.deferUnanswered) {
            deliveredPending.push({ id: result.id, toolCallId: result.toolCallId, kind: result.kind });
            continue;
          }
        } else if (delivery === 'landed') {
          allAnswered = true;
          for (const pending of deliveredPending.splice(0)) {
            if (!this.d.store.acknowledgeSubagentResult(parentSessionId, pending.id)) continue;
            acknowledged.push(pending);
            if (pending.kind === 'subagent') this.publishResultDelivery(parentSessionId, pending.toolCallId, 'acknowledged');
          }
        }
        if (this.d.store.acknowledgeSubagentResult(parentSessionId, result.id)) {
          acknowledged.push({ id: result.id, toolCallId: result.toolCallId, kind: result.kind });
          this.publishResultDelivery(parentSessionId, result.toolCallId, 'acknowledged');
        }
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        this.d.store.noteSubagentResultFailure(parentSessionId, result.id);
        logger('brain-subagent').warn(`sub-agent result ${result.id} for ${parentSessionId} failed delivery attempt ${result.attempts + 1}/${MAX_RESULT_DELIVERY_ATTEMPTS}: ${cause}`);
        if (result.attempts + 1 >= MAX_RESULT_DELIVERY_ATTEMPTS) {
          // Out of timed retries: stop arming a timer for it, but move on to the rest of the queue rather
          // than letting it block them. It keeps its one shot per later drain.
          logger('brain-subagent').warn(`sub-agent result ${result.id} for ${parentSessionId} exhausted ${MAX_RESULT_DELIVERY_ATTEMPTS} timed delivery attempts (last: ${cause}); it stays pending with no timer armed and is only retried once the user sends another message`);
          continue;
        }
        this.scheduleResultRetry(userId, parentSessionId, result.attempts + 1);
        return { answered: false, requiresUserAction, acknowledged, deliveredPending };
      }
    }
    return { answered: allAnswered, requiresUserAction, acknowledged, deliveredPending };
  }

  /** Acknowledge a boot-delivered row only after its dedicated owner continuation settles. */
  acknowledgeDeliveredResult(parentSessionId: string, resultId: string, toolCallId: string, kind: 'subagent' | 'workflow'): void {
    if (!this.d.store.acknowledgeSubagentResult(parentSessionId, resultId)) return;
    if (kind === 'subagent') this.publishResultDelivery(parentSessionId, toolCallId, 'acknowledged');
  }

  private publishResultDelivery(parentSessionId: string, toolCallId: string, delivery: 'pending' | 'acknowledged'): void {
    const run = this.d.store.getSubagentRuns(parentSessionId).find((entry) => entry.toolCallId === toolCallId);
    const live = this.d.sessions.get(parentSessionId);
    if (run && live) {
      const { toolCallId: id, ...state } = run;
      live.replay.publish({ type: 'subagent', id, ...state, resultDelivery: delivery });
    }
  }

  private scheduleResultRetry(userId: number, parentSessionId: string, attempts: number): void {
    if (this.resultRetryTimers.has(parentSessionId)) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(5, attempts));
    const timer = setTimeout(() => {
      this.resultRetryTimers.delete(parentSessionId);
      void this.drainPendingSubagentResults(userId, parentSessionId);
    }, delay);
    timer.unref?.();
    this.resultRetryTimers.set(parentSessionId, timer);
  }

  /** Run one user turn. Without `session` it targets the ACTIVE conversation (web dock — today's
   *  behavior, unchanged); with `session` (a bound CLI) it targets exactly that conversation, wherever
   *  the active pointer points, and never moves the pointer. A bound target that is not live (daemon
   *  restart between turns) is respawned in place first. */
  /** Remove a display-only compaction chip and re-publish the queue so it disappears. Called when the
   *  blocked turn finally starts (its message is no longer waiting) and as a safety net if it never runs. */
  private dropPendingCompactionEcho(live: LiveBrain, id: string): void {
    const echoes = live.pendingCompactionEchoes;
    const index = echoes?.findIndex((echo) => echo.id === id) ?? -1;
    if (echoes && index >= 0) echoes.splice(index, 1);
    live.replay.publish({ type: 'queue', items: queuedWithPending(live) });
  }

  /** The shared cold-start compaction trigger, given the registries it consults — see
   *  {@link maybeColdStartCompaction}. The channel service calls the same function with its own. */
  private coldCompactionDeps(): ColdStartCompactionDeps {
    return { store: this.d.store, sessions: this.d.sessions, elicitation: this.d.elicitation };
  }

  async send(request: TurnRequest): Promise<void> {
    const {
      userId, text, images, internal, clientCwd, session, display, client,
    } = request;
    const mode: TurnMode = request.mode ?? 'build';
    // Once the daemon is draining for shutdown, refuse a NEW turn so the drain can actually converge —
    // every send() here is fresh top-level work (an owner turn, a goal turn, a background nudge), none of
    // it the result delivery or delegated dispatch the drain is waiting on (those take other seams). An
    // interrupted-turn resume is finishing existing work, so it still runs.
    if (this.d.admitsNewWork?.() === false && !request.interruptResume) {
      throw new Error('the daemon is shutting down — try again once it is back up');
    }
    const assertClientCurrent = (sessionId: string): void => {
      if (client && !this.d.lifecycle.authorizeClientRequest(userId, client.id, client.generation, sessionId)) {
        throw new Error('client session has stopped');
      }
    };
    let targetId: string;
    if (session) {
      targetId = this.d.lifecycle.ownedUserSession(userId, session);
      assertClientCurrent(targetId);
      if (!this.d.sessions.get(targetId)) await this.d.lifecycle.ensureLive(userId, targetId, { clientCwd });
      // Stop may have landed while ensureLive awaited provider/session setup. Re-check before this request
      // can persist a user row or enter PI; stopSession itself waits for that spawn lock and disposes it.
      assertClientCurrent(targetId);
    } else {
      targetId = this.d.lifecycle.activeSessionId(userId);
      // start() deliberately publishes the new active pointer before its provider/session assembly
      // finishes, so every surface agrees on the selected conversation. An immediately submitted web
      // turn must join that same per-session spawn lock instead of seeing the pointer without a live PI
      // wrapper and being rejected (which used to drop the composer text client-side).
      if (!this.d.sessions.get(targetId)) await this.d.lifecycle.ensureLive(userId, targetId, { clientCwd });
    }
    const active = this.d.sessions.get(targetId);
    if (!active) throw new Error('brain not started for user');
    // The user spoke: their message IS the continuation of whatever a shutdown parked here, so the boot
    // resume sweep must stand down. Cleared at admission — before any lock — so a message that lands
    // while the sweep is still walking its worklist deterministically wins its claim-check
    // (claimParkResumeAttempt bumps only while the marker stands). Internal turns (goal kickoff, system
    // nudges) are machine work, not the user speaking, and leave the marker alone.
    if (!internal) {
      // The park marker and the activity fence are two halves of the same claim, so they must be stood
      // down together. Boot restamps a PARKED conversation's fence to this boot to keep its resume live
      // (reconcileSessionActivityOnBoot), which leaves the row reading `working` under the PREVIOUS turn's
      // id. If the user speaks before the sweep gets there, clearing only the marker strands that fence
      // where no later compare-and-set can reach it: begin refuses (still `working`), settle refuses
      // (different turn id), and the sweep's own release path is never taken because its claim-check now
      // fails. The conversation would then pulse "working" for the life of the process and lose its unread
      // state for good. Releasing it here is the same neutral idle transition the sweep's give-up paths
      // take — never a `failed`, because nothing failed.
      const parked = this.d.store.getSession(targetId)?.parked_at != null;
      this.d.store.clearSessionPark(targetId);
      if (parked) resetConversationActivity(this.d.store, targetId, undefined, this.d.onConversationActivityChanged);
    }
    // Esc/stop fences the conversation before it snapshots children and clears PI's queue. Never admit a
    // message into that teardown window: the cancelled compaction/run will not drain it, so it would
    // otherwise survive as a phantom chip and execute on a later prompt.
    if (this.d.sessions.isParentAborting(active.sessionId) && !request.interruptResume) {
      throw new Error('session work aborted');
    }
    // An unsafe restart notice is an explicit user-decision gate. Goal continuations carry PI user-role
    // messages too, so reject them visibly (the goal loop pauses on the error); best-effort system nudges may
    // drop. A real user turn synchronously restores the pending notice into a rehydrated/evicted live session
    // BEFORE admission, so the model can never see the original delegation request without its warning.
    const recoveryNotices = this.d.store.pendingSubagentResults(active.sessionId)
      .filter((result) => result.requiresUserAction);
    if (internal && recoveryNotices.length > 0) {
      if (internal.kind === 'systemNudge') return;
      throw new Error('unsafe sub-agent recovery is waiting for a user message');
    }
    if (recoveryNotices.length > 0) {
      await this.drainPendingSubagentResults(userId, active.sessionId);
      const restored = recoveryNotices.every((result) =>
        resultInContext(active.session.messages as CustomResultMessage[], result.id)
        || this.steeredInFlight.get(active.sessionId)?.has(result.id));
      if (!restored) throw new Error('unsafe sub-agent recovery notice could not be restored');
    }
    // PI reports both isStreaming=false and isCompacting=false while a native auto-compaction check is
    // awaiting auth. The coordinator spans that gap. Treat it exactly like the running turn it belongs
    // to: new user input enters PI's native queue and becomes a transcript row only on delivery.
    const turnBusy = active.session.isStreaming || hasActiveNativeCompactionCheck(active.session);
    if (!internal) this.d.goals.cancelGoalContinuation(active.sessionId); // a real (non-internal) user turn cancels any pending goal continuation
    // A system nudge (a finished background command waking the operator's session) is best-effort: if the
    // session is already streaming the agent is busy and needs no wake, so drop it rather than enqueue a
    // stray user turn. When idle it runs straight through, and — crucially — never drives the goal loop
    // (see the skipped afterTurnGoalJudge below), so it can't burn a goal-budget turn or mis-judge a goal.
    if (internal?.kind === 'systemNudge' && turnBusy) return;
    // Everything this turn does besides answering — see openTurn. AFTER the two guards above and before
    // anything can steer or queue: the pin belongs to the request that ordered the turn, and a message
    // sent into a RUNNING turn is steered into it, so it must reach the origin ledger without repointing
    // that turn's attribution (recordRequest owns that asymmetry). Both effects were owned by the HTTP
    // route until now, which is why a goal kickoff, a system nudge and a cron wake-up into an owner
    // conversation appeared in no feed at all.
    //
    // Opening it EARLIER, before the guards, is what made the feed report work that never happens: a nudge
    // dropped because the session is busy and a message rejected into an aborting session both streamed a
    // live "is working" row to every attached browser, one per drop.
    // Internal result wakes have no originating HTTP surface. Preserve CLI-only conversations as CLI;
    // once web has participated, the same owner conversation remains eligible for web unread state.
    const activitySurface: ConversationActivitySurface = conversationActivitySurface(
      request.surface,
      this.d.store.getSessionActivity(active.sessionId)?.webParticipatedAt != null ? 'web' : 'cli');
    const activityTurnId = randomUUID();
    const ownsConversationActivity = !turnBusy;
    let activityState: 'done' | 'failed' | 'idle' = 'failed';
    let activityDetail: string | undefined;
    const opened = openTurn({
      sessionId: active.sessionId,
      ...(request.origin && this.d.usageOrigins
        ? { origin: { pin: this.d.usageOrigins, userId, origin: request.origin, atMs: Date.now() } }
        : {}),
      ...(this.d.recordActivity
        ? { activity: {
            record: this.d.recordActivity,
            actorUserId: userId,
            // An internal turn is nobody's keystroke; naming it as such is what makes it visible at all.
            surface: internal ? 'internal' : (request.surface ?? 'unknown'),
            target: active.sessionId,
          } }
        : {}),
      ...(ownsConversationActivity
        ? { conversationActivity: { store: this.d.store, turnId: activityTurnId, surface: activitySurface, onChanged: this.d.onConversationActivityChanged, defer: true } }
        : {}),
    });
    try {
    // Mid-turn: a message sent while a turn is already streaming is STEERED into the running turn — PI
    // delivers it between steps (after the current tool calls, before the next model call), so the agent
    // folds it in during the SAME turn instead of waiting for it to end. Admission creates only PI queue
    // state; the spawner persists/emits the authoritative user row at PI's later message_start, after the
    // matching queue chip disappeared. Only a real user turn reaches this: internal goal kickoff/
    // continuation drives the loop itself and must run its own turn, and a busy systemNudge already
    // returned above.
    if (turnBusy && !internal) {
      const queuedText = this.contextBuilder.withRunningSubagents(text, active.sessionId);
      const admission = new TurnAdmission(
        { store: this.d.store, titler: this.d.titler, chatImagesDir: this.d.chatImagesDir },
        { live: active, text: queuedText, persistText: text, images, display, mode, visible: true, titleOnAdmission: false, onAdmitted: request.onAdmitted },
      );
      await admission.steer();
      // A steered message settles too, with everything a steer must NOT carry expressed as an absent
      // argument: the running turn curates its own exchange, it is still live so nothing may dispose it,
      // and it will notify on its own. What remains is the writer stamp — the person did write here, and
      // the room surface has always recorded it, so returning early left the two surfaces disagreeing
      // about a message that reached the model either way.
      settleTurn({ sessionId: active.sessionId, lastWriter: { store: this.d.store, userId } });
      return;
    }
    // A manual /compact owns the session lock and ends idle (PI's steer/follow-up queue only delivers inside
    // a running turn), so a message sent underneath it blocks on runTurn's inner lock with no chip. Surface
    // it as a pending queue chip for the compaction's duration; the blocked turn still delivers it right
    // after. Cleared when that turn starts (below) or by the finally net if it never does. Never internal.
    let pendingCompactionEchoId: string | undefined;
    // Armed by a turn that actually produced an answer; consumed once by settleTurn below. A turn that
    // threw leaves it undefined, which is how a failed exchange stays out of the writer's memory.
    let curate: NonNullable<Parameters<typeof settleTurn>[0]['curate']> | undefined;
    if (!internal && active.session.isCompacting) {
      pendingCompactionEchoId = randomUUID();
      (active.pendingCompactionEchoes ??= []).push({ id: pendingCompactionEchoId, text: display ?? text });
      active.replay.publish({ type: 'queue', items: queuedWithPending(active) });
    }
    // Run ONE user turn on `live`. Refactored out of send() so the flush loop below can replay it for the
    // drained queue with the same idle-rollover-safe serialization. `isUserTurn` marks a turn the DAEMON
    // must render as a 'you' bubble — a normal send AND a drained queued delivery, but never an internal
    // goal kickoff/continuation. When set, a `user` event streams so the sender renders the turn from the
    // stream (no client-side optimistic echo); `echoDisplay` is the client's clean text (else persistText).
    const runTurn = async (live: LiveBrain, turnText: string, turnImages: TurnImage[] | undefined, turnMode: TurnMode, isUserTurn: boolean, echoDisplay: string | undefined): Promise<void> => {
      // Serialized per conversation: concurrent prompt() calls on one PI session corrupt turn state.
      await this.serial(live.sessionId, async () => {
      assertClientCurrent(live.sessionId);
      // First turn after the prompt cache expired: shrink the context BEFORE the provider re-caches it
      // (see maybeColdStartCompaction). Runs before admission so the user's new message is never part
      // of what gets summarized — it follows the compacted context instead.
      await maybeColdStartCompaction(this.coldCompactionDeps(), live);

      // Lock acquired means the compaction that was blocking this turn has released: the message is running
      // now, not waiting, so drop its pending chip before the turn's own user echo lands.
      if (pendingCompactionEchoId) {
        this.dropPendingCompactionEcho(active, pendingCompactionEchoId);
        pendingCompactionEchoId = undefined;
      }
      const turnRequest: TurnRequest = {
        ...request,
        text: turnText,
        images: turnImages,
        mode: turnMode,
        display: echoDisplay,
      };
      const admission = new TurnAdmission(
        { store: this.d.store, titler: this.d.titler, chatImagesDir: this.d.chatImagesDir },
        { live, text: turnText, images: turnImages, display: echoDisplay, mode: turnMode, visible: isUserTurn, titleOnAdmission: isUserTurn, onAdmitted: request.onAdmitted },
      );
      admission.prepare();
      try {
      // Before the turn context, not after it: building that context awaits turn-start memory recall — a
      // remote embedding with a 30 s deadline — and the sender's own message is rendered from this event
      // alone, so waiting on it left a sent message invisible for 1.4–5.8 s. The prompt below still gets
      // the recalled memories; only the echo is off that path.
      admission.echo();
      const context = await this.contextBuilder.build(turnRequest, live);
      // Meter the turn so the OpenRouter (or OpenRouter-backed proxy) cost pi-ai drops is captured and
      // stamped onto the persisted assistant row by projectEvent (fired synchronously in this scope).
      const meter = newCostMeter();
      await runWithMeter(meter, () => context.run(async (prompted, confirmProviderPreflight) => {
        // PI's preflightResult fires after extension/input/template/auth/compaction preparation and directly
        // before _runAgentPrompt. ADMITTING there closes the 202→isStreaming=false window: the prompt run
        // becomes active in the same call stack before an HTTP follow-up can resume and steer it. Turn-start
        // recall commits at this same boundary: early enough for liveRecall's in-turn dedup, but only after PI
        // has accepted the prompt so a rejected/rolled-back turn leaves no permanent memory delivery behind.
        const options = {
          images: turnImages?.length
            ? turnImages.map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType }))
            : undefined,
          preflightResult: (success: boolean): void => {
            // Final fail-closed check at PI's actual provider boundary. Recovery may finish while context/memory
            // assembly awaits; if its new notice is not in this exact live context, reject before the model sees
            // the old delegation request. A real user send retries restoration; an internal caller fails visibly.
            if (success) {
              const missingRecoveryNotice = this.d.store.pendingSubagentResults(live.sessionId)
                .some((result) => result.requiresUserAction
                  && !resultInContext(live.session.messages as CustomResultMessage[], result.id));
              if (missingRecoveryNotice) throw new Error('unsafe sub-agent recovery notice could not be restored');
            }
            admission.preflightResult(success);
            if (success) confirmProviderPreflight();
          },
        };
        // Context/memory/plugin hooks above are asynchronous. A quit that landed while they ran must fence
        // the provider call even though this send had already entered its turn callback.
        assertClientCurrent(live.sessionId);
        await live.session.prompt(prompted, options);
        // Requests provably went out under THIS process's cache retention — record the TTL they were
        // cached with for the cold-start gate. Stamped only after a successful prompt: a rejected
        // preflight may have made no request at all, and an unstamped session just falls back to the
        // conservative longest TTL.
        live.lastRequestCacheTtlMs = cacheTtlMs(process.env);
        // Thinking-only guard (#115): reasoning models sometimes end a 'stop' turn with ONLY a thinking
        // block — no text, no tool call — so the user sees nothing. ONE automatic nudge re-prompts the
        // same session; the nudge itself is never persisted as a user message (agent_end persists only
        // assistant/tool messages, and projectUserTurn is not called for it), while its assistant reply
        // persists and streams to attached clients as a normal continuation. Straight-line by design:
        // a nudge that again produces nothing simply ends — no loop.
        const settled = lastAssistant(live.session.messages as { role?: string }[]);
        if (settled && isThinkingOnlyReply(settled)) {
          assertClientCurrent(live.sessionId);
          await live.session.prompt(NO_REPLY_NUDGE);
        }
      }));
      // Post-turn curator: extract durable facts from this exchange. Only ARMED here, where the turn's
      // own text and auto-save verdict are in scope; settleTurn below runs it, so the owner surface and
      // a room cannot drift into curating different things (they already had).
      if (this.d.curator && context.autoSaveMemory) {
        const last = lastAssistant(live.session.messages as { role?: string }[]);
        curate = {
          curator: this.d.curator,
          userId,
          userText: turnText,
          assistantText: last ? extractText(last) : '',
        };
      }
      // Auto-compaction is PI-native (configured per session via the SettingsManager in the factory):
      // PI summarizes the context on its own once it fills past the user's %, right after this agent_end.
      // The factory's subscription mirrors that compaction into the store and the spawner fans `compacted`
      // to clients — so there is nothing to trigger or persist here.
      } catch (error) {
        // projectUserTurn intentionally precedes PI prompt() so pre-prompt compaction can see it. Until
        // PI's native preflight succeeds the row stays hidden; rejection rolls it back atomically from the
        // caller's perspective, avoiding a visible ghost prompt and duplicate row on retry.
        admission.rollbackPending();
        throw error;
      }
      });
    };
    // Serialized per CONVERSATION for the whole turn (outer `send-<id>` key): the idle rollover and the
    // vision-fallback respawn dispose and recreate the session, which MUST NOT race a concurrent send()
    // into the same conversation. Holding this lock is what keeps steering correct — any concurrent
    // /brain/send either sees isStreaming (→ steer) or blocks here, so no turn ever runs outside the
    // serial. The key is the TARGET conversation (not the user), so two bound clients working DIFFERENT
    // conversations still run concurrently; `send-` prefixing keeps ensureLive() re-entrant from here. The
    // inner (bare session id) lock in runTurn guards each prompt().
    let completedSessionId = active.sessionId;
    try {
      await this.serial(sendLockKey(targetId), async () => {
        // Re-resolve under the lock: an unbound send that queued behind a rollover/model switch must follow
        // the active pointer to wherever the conversation went; a bound send stays on its explicit target.
        let b = session ? this.d.sessions.get(targetId) : this.d.lifecycle.activeLive(userId);
        if (!b) throw new Error('brain not started for user');
        assertClientCurrent(b.sessionId);
        // Idle rollover — see ConversationLifecycle.maybeRollover. INTERNAL sends (goal kickoff /
        // continuation) never roll over — the goal row is keyed to the session it was set on; moving its
        // kickoff to a fresh session would orphan the goal (judge finds no row, loop never starts).
        if (!internal) b = await this.d.lifecycle.maybeRollover(userId, b, clientCwd);
        // Vision fallback — see ConversationLifecycle.maybeVisionHop (an image turn on a text-only model
        // respawns onto the user's vision model in place, and hops back on the next text-only turn).
        b = await this.d.lifecycle.maybeVisionHop(userId, b, !!images?.length, clientCwd);
        assertClientCurrent(b.sessionId);
        // Markers land on the SESSION THE TURN ACTUALLY RUNS ON — resolved only here, after rollover/vision-hop
        // may have replaced it. Recording them on the pre-lock `active` would strand the marker + its queued
        // model-facing notice on the archived session a rollover just left behind (they ride `b`, which carries
        // only listeners across the hop). A reasoning change still riding its debounce is landed first so its
        // row precedes this turn's user message; the mode switch (build↔plan↔workflow, client-stamped per send
        // with no discrete daemon event) is compared against the last mode seen on this session. Internal goal
        // turns are always build and never roll over — they must not perturb the baseline or emit a marker.
        flushReasoningMarker(this.d.store, b);
        if (!internal) {
          if (b.lastMode !== undefined && b.lastMode !== mode) {
            recordSessionEvent(this.d.store, b.sessionId, b, 'mode', `${mode[0]!.toUpperCase()}${mode.slice(1)}`);
          }
          b.lastMode = mode;
        }
        // The conversation ↔ launch-directory binding follows explicit client cwds (feeds the CLI's
        // default-start resolution); fallback-resolved dirs are never stamped.
        if (clientCwd) this.d.lifecycle.stampWorkDir(b.sessionId, clientCwd, b.policy);
        completedSessionId = b.sessionId;
        // The pin follows the turn to the conversation it actually runs in. An idle rollover archives the
        // old transcript and mints a FRESH session id, and settlement happens under that new id — so a pin
        // left on the pre-lock id was found by nobody and the first turn after every rollover recorded as
        // `internal` against the row owner instead of the surface the person was sitting at.
        opened.movedTo(b.sessionId);
        // The activity projection opens only after the conversation admission lock is held. This makes two
        // concurrent idle sends serialize as two real turns instead of one replacing the other's working CAS.
        opened.begin();
        await runTurn(b, text, images, mode, !internal, display);
        // A turn that RETURNS is not a turn that succeeded. PI resolves `prompt()` on a provider error and
        // on an abort alike — it settles the assistant with `stopReason: 'error'` and empty content rather
        // than throwing (channels.ts makes the same allowance where it explains it) — so neither reaches
        // the catch below. Reading the settled assistant is exactly what the delegated delivery path above
        // already does, for this reason. Without it a provider outage the user watched fail is filed as
        // `done`, and the rail answers with a green check and no reason.
        const outcome = lastAssistant(
          (this.d.sessions.get(completedSessionId)?.session.messages ?? []) as { role?: string; stopReason?: string; errorMessage?: string }[],
        );
        if (outcome?.stopReason === 'aborted') {
          // A stop is the user's own decision. Reporting their own Esc back at them as a failure would be
          // the same mistake the catch below already declines to make for a thrown abort.
          activityState = 'idle';
        } else if (outcome?.stopReason === 'error') {
          activityState = 'failed';
          activityDetail = outcome.errorMessage?.trim() || undefined;
        } else {
          activityState = 'done';
        }
      });
    } catch (error) {
      const live = this.d.sessions.get(completedSessionId);
      const latest = live ? lastAssistant(live.session.messages as { role?: string; stopReason?: string }[]) : undefined;
      const message = error instanceof Error ? error.message : String(error);
      const aborted = latest?.stopReason === 'aborted' || /\babort(?:ed|ing)?\b|session work stopped/i.test(message);
      activityState = aborted ? 'idle' : 'failed';
      activityDetail = aborted ? undefined : message;
      throw error;
    } finally {
      // Safety net: if the turn threw before it started (rollover/preflight rejection), its pending
      // compaction chip is still up — drop it so a rejected send never leaves a phantom waiting chip.
      if (pendingCompactionEchoId) this.dropPendingCompactionEcho(active, pendingCompactionEchoId);
      // The turn is over, so PI's steering queue is gone with it and nothing steered into it is still in
      // flight. Forget them BEFORE the re-drain: an id held back past the turn it belonged to would make
      // the next drain skip a result that never arrived, turning a duplicate into a loss.
      this.steeredInFlight.delete(completedSessionId);
      // Unsafe-recovery notices stay pending across boots until a user message actually follows them in the
      // live context. That message is the explicit parent turn which may choose DelegateContinue; only now is
      // it safe to release the durable gate and let later ordinary results wake autonomously again.
      const completedLive = this.d.sessions.get(completedSessionId);
      if (!internal && completedLive) {
        for (const result of this.d.store.pendingSubagentResults(completedSessionId)) {
          if (!result.requiresUserAction
            || !resultFollowedByUser(completedLive.session.messages as CustomResultMessage[], result.id)) continue;
          this.acknowledgeDeliveredResult(completedSessionId, result.id, result.toolCallId, result.kind);
        }
      }
      // A sub-agent result that arrived while this turn was streaming was STEERED into it and left durable +
      // pending, because PI accepting a steer is not yet proof the context holds it. Now that the turn has
      // settled, re-drain: this pass finds the message in the transcript and acknowledges it — or, if a stop
      // cleared PI's queue first, delivers it for real. The drain never calls send(), so no recursion.
      if (this.d.store.pendingSubagentResults(completedSessionId).length > 0) {
        void this.drainPendingSubagentResults(userId, completedSessionId);
      }
      // The settlement side of the turn — see settleTurn. The plugin reload it drains (e.g. after a
      // CreateSkill) runs here rather than inside the turn because the send lock is released, so
      // respawning this session no longer races the turn that asked for it.
      //
      // `notify` is the owner surface's own argument and a room omits it. `userInitiated` means "a person
      // asked for this", so only `internal` disqualifies a turn: it must NOT also require the absence of
      // `client`, because the web binds its sends exactly like the CLI does and that test excluded every
      // real chat message. Whether anyone is actually reading is a separate question the callback answers.
      settleTurn({
        sessionId: completedSessionId,
        ...(curate ? { curate } : {}),
        // The owner IS the writer of their own chat. Without this the conversation register showed an
        // empty writer column for every CLI and web row while platform rows carried one.
        lastWriter: { store: this.d.store, userId },
        ...(this.d.drainPluginReload ? { drainPluginReload: this.d.drainPluginReload } : {}),
        ...(this.d.notifyTurnComplete
          ? { notify: () => this.d.notifyTurnComplete!(userId, completedSessionId, !internal, client?.id) }
          : {}),
        ...(ownsConversationActivity
          ? { conversationActivity: {
              store: this.d.store,
              turnId: activityTurnId,
              surface: activitySurface,
              state: activityState,
              onChanged: this.d.onConversationActivityChanged,
              ...(activityDetail ? { detail: activityDetail } : {}),
            } }
          : {}),
      });
      if (ownsConversationActivity) {
        const activity = this.d.store.getSessionActivity(completedSessionId);
        const live = this.d.sessions.get(completedSessionId);
        if (activity && live) live.replay.publish({ type: 'idle', activitySeq: activity.seq });
      }
    }
    if (internal?.kind !== 'systemNudge') this.d.goals.afterTurnGoalJudge(userId, completedSessionId, internal);
    } finally {
      // Every exit of the turn this opened, including the ones that never reach a provider: a rollover
      // rejection, a stopped client, a steer that threw. Releases only the pin this turn set.
      opened.close();
    }
  }
}
