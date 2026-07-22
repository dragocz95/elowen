import type { PluginRegistry } from '../../plugins/registry.js';
import type { HookAuditBuffer } from '../../shared/hookAudit.js';
import type { BrainStore } from '../../store/brainStore.js';
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
import type { SubagentCompletion } from '../events.js';
import { randomUUID } from 'node:crypto';
import { isNonUserSession } from '../sessionId.js';
import { xmlEscape } from '../../shared/xml.js';
import { logger } from '../../shared/logger.js';

/** A durable sub-agent result is retried at most this many times before the drain gives up (leaves the
 *  row pending, no further timer). A later user turn on the parent re-triggers one more attempt. */
const MAX_RESULT_DELIVERY_ATTEMPTS = 5;

/** Raised when a hidden sub-agent-result delivery finds the parent session already streaming a turn. PI
 *  would only PARK the follow-up in its native queue — a structural duplicate of what the running turn
 *  already sees — so we refuse to touch PI and leave the result durable + pending. send()'s post-turn
 *  hook re-drains it once the turn settles. Distinct from a transport failure: the drain neither notes a
 *  failure nor schedules a retry timer for it. */
class ParentTurnBusyError extends Error {
  constructor(sessionId: string) {
    super(`parent session ${sessionId} is streaming; deferring sub-agent result delivery`);
    this.name = 'ParentTurnBusyError';
  }
}

interface TurnRunnerDeps {
  store: BrainStore;
  /** The shared live-session state (owned by the BrainService facade). */
  sessions: LiveSessionRegistry<LiveBrain>;
  lifecycle: ConversationLifecycle;
  goals: GoalLoopService;
  permissions: PermissionApprovalService;
  elicitation: ElicitationRegistry;
  cards: CardRegistry;
  /** The ONE place turn identities (and the owner check) are minted. */
  identity: IdentityResolver;
  /** Names a brand-new conversation from its first message — see BrainService. */
  titler: ConversationTitler;
  /** Post-turn memory curator — present only when the memory deps are wired. */
  curator?: MemoryCurator;
  prompts: BrainDeps['prompts'];
  users: BrainDeps['users'];
  userSettings?: BrainDeps['userSettings'];
  memoryService?: MemoryService;
  /** The daemon-wide plugin registry (undefined when plugins aren't wired at all). */
  plugins(): Promise<PluginRegistry | undefined>;
  hookAudit?: HookAuditBuffer;
  projectPath?: () => string | undefined;
  sendDelegatedCustom?(userId: number, sessionId: string, customType: string, content: string, resultId: string): Promise<void>;
  /** Fired once a turn has fully settled (outside the per-conversation send lock). Lets the brain drain
   *  deferred, session-disposing work a tool requested mid-turn — currently a pending plugin reload. */
  afterTurnSettled?(userId: number): void;
}

/** The owner-chat turn pipeline: mid-run steering, idle rollover + vision hop (delegated to the
 *  lifecycle), the live-prompt assembly (memory/hook/permissions blocks + turn context), the
 *  runWithPolicy scope with its turn-bound emitters, the thinking-only nudge, the post-turn curator
 *  kickoff, auto-compact and the goal judge. */
export class BrainTurnRunner {
  private contextBuilder: TurnContextBuilder;
  private readonly resultDrains = new Set<string>();
  private readonly resultRetryTimers = new Map<string, NodeJS.Timeout>();

  constructor(private d: TurnRunnerDeps) {
    this.contextBuilder = new TurnContextBuilder({
      ...d,
      completeSubagent: (parentSessionId, userId, completion) => {
        this.acceptSubagentCompletion(parentSessionId, userId, completion);
      },
    });
  }

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.d.sessions.withLock(key, fn);
  }

  /** Deliver host-owned lifecycle information through PI's native hidden custom-message seam. The
   * conversation lock places it after the current owner turn; `display:false` keeps it out of the user
   * transcript, while `triggerTurn` lets the main agent react when idle. */
  async sendCustomSystem(userId: number, session: string, customType: string, content: string, resultId?: string): Promise<void> {
    if (isNonUserSession(session)) {
      if (!resultId || !this.d.sendDelegatedCustom) throw new Error('delegated result delivery unavailable');
      await this.d.sendDelegatedCustom(userId, session, customType, content, resultId);
      return;
    }
    const target = this.d.lifecycle.ownedUserSession(userId, session);
    if (!this.d.sessions.get(target)) await this.d.lifecycle.ensureLive(userId, target);
    // The bare session lock (inner) is nested under the outer `send-` lock, matching a user turn's own
    // ordering (send-<id> → <id>), so this never deadlocks against a concurrent send()/compact/stop.
    await this.serial(`send-${target}`, () => this.serial(target, async () => {
      const live = this.d.sessions.get(target);
      if (!live) throw new Error('brain not started for user');
      // A streaming parent would only PARK this follow-up in PI's native queue — a structural duplicate of
      // what the running turn already sees. Refuse BEFORE touching PI and leave the result pending; send()'s
      // post-turn hook re-drains it once the turn settles (no note-failure, no retry timer for this case).
      if (live.session.isStreaming) throw new ParentTurnBusyError(target);
      const before = lastAssistant(live.session.messages as { role?: string }[]);
      const context = this.contextBuilder.buildScope(userId, live);
      await context.run(() => live.session.sendCustomMessage({
        customType,
        content,
        display: false,
        details: { source: 'elowen', ...(resultId ? { resultId } : {}) },
      }, { triggerTurn: true, deliverAs: 'followUp' }));
      const settled = lastAssistant(live.session.messages as { role?: string; stopReason?: string; errorMessage?: string }[]);
      // A turn that did not settle normally is NOT automatically a failure to deliver: PI appends the
      // custom message to the transcript before running the turn, so the result may already be in the
      // parent's context, and re-delivering it would put it there twice. Don't assume from the turn's
      // shape — look for the message. It carries our result id, so its presence is the only honest answer
      // to "did this land?", whatever became of the turn afterwards.
      const landed = (live.session.messages as { role?: string; details?: { resultId?: string } }[])
        .some((message) => message.role === 'custom' && message.details?.resultId === resultId);
      // No new assistant at all. Usually a genuine non-delivery — but PI strips the errored assistant out
      // of live state BEFORE its retry backoff, so a retry the user cancels mid-sleep settles with the
      // pre-delivery assistant still last, having already put the result in context.
      if (!settled || settled === before) {
        if (!landed) throw new Error('sub-agent result was not processed by the parent model');
        logger('brain-subagent').info(`sub-agent result for ${target} entered the context of a cancelled parent retry; acknowledging without retry`);
        return;
      }
      // Two ways to get here. The user aborted the turn mid-flight (Esc / stop). Or the parent's own model
      // turn errored — which says nothing about the CHILD's result: the delivery budget exists for a
      // transport that could not carry it, and spending it on the parent's provider outage is what burns
      // all five attempts in half a minute and strands a perfectly good result.
      if (settled.stopReason === 'aborted' || settled.stopReason === 'error') {
        const why = settled.stopReason === 'aborted' ? 'aborted' : 'errored';
        if (!landed) throw new Error(settled.errorMessage?.trim() || `parent turn ${why} before the sub-agent result reached its context`);
        logger('brain-subagent').info(`sub-agent result for ${target} entered the context of an ${why} parent turn; acknowledging without retry`);
      }
    }));
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

  /** Deliver every durable pending result serially after any active owner turn. A failed transport or
   * model turn leaves the row pending and schedules bounded retry; no permanent poller exists. */
  async drainPendingSubagentResults(userId: number, parentSessionId: string): Promise<void> {
    if (this.resultDrains.has(parentSessionId)) return;
    this.resultDrains.add(parentSessionId);
    const oldTimer = this.resultRetryTimers.get(parentSessionId);
    if (oldTimer) { clearTimeout(oldTimer); this.resultRetryTimers.delete(parentSessionId); }
    try {
      // Each result gets at most one shot per drain, so a poisoned one cannot sit at the head of the queue
      // failing forever and starve everything behind it — the user would silently stop receiving any
      // delegated work at all. It is still retried on the next drain: the cause may be an outage that
      // outlives the timed retries, and the result is only worthless once it is delivered.
      const attempted = new Set<string>();
      while (true) {
        const result = this.d.store.pendingSubagentResults(parentSessionId).find((row) => !attempted.has(row.id));
        if (!result) break;
        attempted.add(result.id);
        const body = result.status === 'done'
          ? `<result>${xmlEscape(result.result ?? '(the sub-agent returned nothing)')}</result>`
          : `<error>${xmlEscape(result.error ?? 'unknown sub-agent error')}</error>`;
        const content = '<system-reminder>\n'
          + `<subagent-result id="${xmlEscape(result.id)}" session="${xmlEscape(result.sessionId)}" status="${result.status}">\n`
          + `<task>${xmlEscape(result.task)}</task>\n${body}\n</subagent-result>\n`
          + '<instruction>A background sub-agent finished. Incorporate this result into your current work. '
          + 'The child transcript remains available separately; do not claim its internal tool calls as your own.</instruction>\n'
          + '</system-reminder>';
        try {
          await this.sendCustomSystem(userId, parentSessionId, 'subagent-result', content, result.id);
          if (this.d.store.acknowledgeSubagentResult(parentSessionId, result.id)) {
            this.publishResultDelivery(parentSessionId, result.toolCallId, 'acknowledged');
          }
        } catch (error) {
          // A streaming parent isn't a failure — the result stays pending and send()'s post-turn hook will
          // re-drain it. Don't burn an attempt or arm a retry timer.
          if (error instanceof ParentTurnBusyError) return;
          const cause = error instanceof Error ? error.message : String(error);
          this.d.store.noteSubagentResultFailure(parentSessionId, result.id, cause);
          logger('brain-subagent').warn(`sub-agent result ${result.id} for ${parentSessionId} failed delivery attempt ${result.attempts + 1}/${MAX_RESULT_DELIVERY_ATTEMPTS}: ${cause}`);
          if (result.attempts + 1 >= MAX_RESULT_DELIVERY_ATTEMPTS) {
            // Out of timed retries: stop arming a timer for it, but move on to the rest of the queue rather
            // than letting it block them. It keeps its one shot per later drain.
            logger('brain-subagent').warn(`sub-agent result ${result.id} for ${parentSessionId} exhausted ${MAX_RESULT_DELIVERY_ATTEMPTS} timed delivery attempts (last: ${cause}); it stays pending with no timer armed and is only retried once the user sends another message`);
            continue;
          }
          this.scheduleResultRetry(userId, parentSessionId, result.attempts + 1);
          return;
        }
      }
    } finally {
      this.resultDrains.delete(parentSessionId);
    }
  }

  private publishResultDelivery(parentSessionId: string, toolCallId: string, delivery: 'pending' | 'acknowledged'): void {
    const run = this.d.store.getSubagentRuns(parentSessionId).find((entry) => entry.toolCallId === toolCallId);
    const live = this.d.sessions.get(parentSessionId);
    if (run && live) live.replay.publish({ type: 'subagent', id: toolCallId, ...run, resultDelivery: delivery });
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

  async send(request: TurnRequest): Promise<void> {
    const {
      userId, text, images, internal, clientCwd, session, display, client,
    } = request;
    const mode: TurnMode = request.mode ?? 'build';
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
    // Esc/stop fences the conversation before it snapshots children and clears PI's queue. Never admit a
    // message into that teardown window: the cancelled compaction/run will not drain it, so it would
    // otherwise survive as a phantom chip and execute on a later prompt.
    if (this.d.sessions.isParentAborting(active.sessionId) && !request.interruptResume) {
      throw new Error('session work aborted');
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
    // Mid-turn: a message sent while a turn is already streaming is STEERED into the running turn — PI
    // delivers it between steps (after the current tool calls, before the next model call), so the agent
    // folds it in during the SAME turn instead of waiting for it to end. Admission creates only PI queue
    // state; the spawner persists/emits the authoritative user row at PI's later message_start, after the
    // matching queue chip disappeared. Internal goal kickoff/continuation is never steered — it drives
    // the loop itself and must run its own turn.
    if (turnBusy && (!internal || internal.kind === 'systemNudge')) {
      const queuedText = this.contextBuilder.withRunningSubagents(text, active.sessionId);
      const admission = new TurnAdmission(
        { store: this.d.store, titler: this.d.titler },
        { live: active, text: queuedText, persistText: text, images, display, mode, visible: true, titleOnAdmission: false, onAdmitted: request.onAdmitted },
      );
      await admission.steer();
      return;
    }
    // A manual /compact owns the session lock and ends idle (PI's steer/follow-up queue only delivers inside
    // a running turn), so a message sent underneath it blocks on runTurn's inner lock with no chip. Surface
    // it as a pending queue chip for the compaction's duration; the blocked turn still delivers it right
    // after. Cleared when that turn starts (below) or by the finally net if it never does. Never internal.
    let pendingCompactionEchoId: string | undefined;
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
        { store: this.d.store, titler: this.d.titler },
        { live, text: turnText, images: turnImages, display: echoDisplay, mode: turnMode, visible: isUserTurn, titleOnAdmission: isUserTurn, onAdmitted: request.onAdmitted },
      );
      admission.prepare();
      try {
      // PI's preflightResult fires after extension/input/template/auth/compaction preparation and directly
      // before _runAgentPrompt. Publishing + admitting there closes the 202→isStreaming=false window: the
      // prompt run becomes active in the same call stack before an HTTP follow-up can resume and steer it.
      const options = {
        images: turnImages?.length
          ? turnImages.map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType }))
          : undefined,
        preflightResult: admission.preflightResult,
      };
      const context = await this.contextBuilder.build(turnRequest, live);
      // Meter the turn so the OpenRouter (or OpenRouter-backed proxy) cost pi-ai drops is captured and
      // stamped onto the persisted assistant row by projectEvent (fired synchronously in this scope).
      const meter = newCostMeter();
      await runWithMeter(meter, () => context.run(async (prompted) => {
        // Context/memory/plugin hooks above are asynchronous. A quit that landed while they ran must fence
        // the provider call even though this send had already entered its turn callback.
        assertClientCurrent(live.sessionId);
        await live.session.prompt(prompted, options);
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
      // Post-turn curator: extract durable facts from this exchange in the background. Fire-and-forget
      // (mirrors brainWorker) — never awaited, never touches live.session, swallows its own errors.
      if (this.d.curator && context.autoSaveMemory) {
        const last = lastAssistant(live.session.messages as { role?: string }[]);
        const assistantText = last ? extractText(last) : '';
        void this.d.curator.run(userId, turnText, assistantText).catch(() => { /* curator is best-effort */ });
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
      await this.serial(`send-${targetId}`, async () => {
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
        await runTurn(b, text, images, mode, !internal, display);
      });
    } finally {
      // Safety net: if the turn threw before it started (rollover/preflight rejection), its pending
      // compaction chip is still up — drop it so a rejected send never leaves a phantom waiting chip.
      if (pendingCompactionEchoId) this.dropPendingCompactionEcho(active, pendingCompactionEchoId);
      // A sub-agent result that arrived while this turn was streaming was DEFERRED (ParentTurnBusyError) and
      // left durable + pending. Now that the turn has settled, re-drain it — this post-turn hook is the ONLY
      // re-trigger for a streaming-deferred result. The drain never calls send(), so there is no recursion.
      if (this.d.store.pendingSubagentResults(completedSessionId).length > 0) {
        void this.drainPendingSubagentResults(userId, completedSessionId);
      }
      // Apply any plugin reload a tool requested during this turn (e.g. CreateSkill): the send lock is
      // released, so respawning this session no longer races the turn that asked for it.
      this.d.afterTurnSettled?.(userId);
    }
    if (internal?.kind !== 'systemNudge') this.d.goals.afterTurnGoalJudge(userId, completedSessionId, internal);
  }
}
