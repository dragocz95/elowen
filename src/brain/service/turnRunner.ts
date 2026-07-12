import type { PluginRegistry } from '../../plugins/registry.js';
import type { HookAuditBuffer } from '../../shared/hookAudit.js';
import type { BrainStore } from '../../store/brainStore.js';
import type { MemoryService } from '../memoryService.js';
import type { MemoryCurator } from '../memoryCurator.js';
import type { ConversationTitler } from '../conversationTitler.js';
import type { ElicitationRegistry } from '../elicitation.js';
import type { CardRegistry } from '../cards.js';
import type { IdentityResolver } from '../identity.js';
import { extractText, isThinkingOnlyReply, NO_REPLY_NUDGE } from '../messageView.js';
import { newCostMeter, runWithMeter } from '../openrouterMeter.js';
import type { LiveSessionRegistry } from '../session/liveRegistry.js';
import type { LiveBrain } from '../session/liveBrain.js';
import type { BrainDeps } from '../brainDeps.js';
import type { ConversationLifecycle } from './lifecycle.js';
import type { GoalLoopService } from './goalLoop.js';
import type { PermissionApprovalService } from './permissionApproval.js';
import { TurnAdmission } from './turnAdmission.js';
import { TurnContextBuilder } from './turnContextBuilder.js';
import type { TurnImage, TurnMode, TurnRequest } from './turnRequest.js';
import { hasActiveNativeCompactionCheck } from '../session/compactionCheckCoordinator.js';

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
}

/** The owner-chat turn pipeline: mid-run steering, idle rollover + vision hop (delegated to the
 *  lifecycle), the live-prompt assembly (memory/hook/permissions blocks + turn context), the
 *  runWithPolicy scope with its turn-bound emitters, the thinking-only nudge, the post-turn curator
 *  kickoff, auto-compact and the goal judge. */
export class BrainTurnRunner {
  private contextBuilder: TurnContextBuilder;

  constructor(private d: TurnRunnerDeps) {
    this.contextBuilder = new TurnContextBuilder(d);
  }

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.d.sessions.withLock(key, fn);
  }

  /** Run one user turn. Without `session` it targets the ACTIVE conversation (web dock — today's
   *  behavior, unchanged); with `session` (a bound CLI) it targets exactly that conversation, wherever
   *  the active pointer points, and never moves the pointer. A bound target that is not live (daemon
   *  restart between turns) is respawned in place first. */
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
    // PI reports both isStreaming=false and isCompacting=false while a native auto-compaction check is
    // awaiting auth. The coordinator spans that gap. Treat it exactly like the running turn it belongs
    // to: new user input enters PI's native queue and becomes a transcript row only on delivery.
    const turnBusy = active.session.isStreaming || hasActiveNativeCompactionCheck(active.session);
    if (!internal?.goalKickoff && !internal?.goalContinue && !internal?.systemNudge) this.d.goals.cancelGoalContinuation(active.sessionId);
    // A system nudge (a finished background command waking the operator's session) is best-effort: if the
    // session is already streaming the agent is busy and needs no wake, so drop it rather than enqueue a
    // stray user turn. When idle it runs straight through, and — crucially — never drives the goal loop
    // (see the skipped afterTurnGoalJudge below), so it can't burn a goal-budget turn or mis-judge a goal.
    if (internal?.systemNudge && turnBusy) return;
    // Mid-turn: a message sent while a turn is already streaming is STEERED into the running turn — PI
    // delivers it between steps (after the current tool calls, before the next model call), so the agent
    // folds it in during the SAME turn instead of waiting for it to end. Admission creates only PI queue
    // state; the spawner persists/emits the authoritative user row at PI's later message_start, after the
    // matching queue chip disappeared. Internal goal kickoff/continuation is never steered — it drives
    // the loop itself and must run its own turn.
    if (turnBusy && !internal?.goalKickoff && !internal?.goalContinue) {
      const admission = new TurnAdmission(
        { store: this.d.store, titler: this.d.titler },
        { live: active, text, images, display, visible: true, titleOnAdmission: false, onAdmitted: request.onAdmitted },
      );
      await admission.steer();
      return;
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
      const turnRequest: TurnRequest = {
        ...request,
        text: turnText,
        images: turnImages,
        mode: turnMode,
        display: echoDisplay,
      };
      const admission = new TurnAdmission(
        { store: this.d.store, titler: this.d.titler },
        { live, text: turnText, images: turnImages, display: echoDisplay, visible: isUserTurn, titleOnAdmission: isUserTurn, onAdmitted: request.onAdmitted },
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
        const settled = [...(live.session.messages as { role?: string }[])].reverse().find((m) => m.role === 'assistant');
        if (settled && isThinkingOnlyReply(settled)) {
          assertClientCurrent(live.sessionId);
          await live.session.prompt(NO_REPLY_NUDGE);
        }
      }));
      // Post-turn curator: extract durable facts from this exchange in the background. Fire-and-forget
      // (mirrors brainWorker) — never awaited, never touches live.session, swallows its own errors.
      if (this.d.curator && context.autoSaveMemory) {
        const last = [...(live.session.messages as { role?: string }[])].reverse().find((m) => m.role === 'assistant');
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
      // The conversation ↔ launch-directory binding follows explicit client cwds (feeds the CLI's
      // default-start resolution); fallback-resolved dirs are never stamped.
      if (clientCwd) this.d.lifecycle.stampWorkDir(b.sessionId, clientCwd, b.policy);
      completedSessionId = b.sessionId;
      await runTurn(b, text, images, mode, !internal, display);
    });
    if (!internal?.systemNudge) this.d.goals.afterTurnGoalJudge(userId, completedSessionId, mode, internal);
  }
}
