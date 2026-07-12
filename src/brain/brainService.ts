import type { PluginRegistry } from '../plugins/registry.js';
import { PluginHookBus } from '../plugins/hookBus.js';
import { ElicitationRegistry } from './elicitation.js';
import { CardRegistry } from './cards.js';
import type { BrainSearchHit, BrainGoalRow } from '../store/brainStore.js';
import { MemoryCurator } from './memoryCurator.js';
import { ConversationTitler } from './conversationTitler.js';
import { logger } from '../shared/logger.js';
import { BrainSessionFactory } from './session/factory.js';
import { IdentityResolver } from './identity.js';
import { LiveSessionRegistry } from './session/liveRegistry.js';
import type { LiveBrain } from './session/liveBrain.js';
import { enqueueMirrored } from './session/queueMirror.js';
import { ChannelSessionService } from './channels.js';
import type { ChannelSendOpts } from './channels.js';
import { PlatformOrchestrator } from './platforms.js';
import type { BrainMessageView } from './messageView.js';
import { runCompaction, queueItems, withDescendantUsage } from './events.js';
import type { AskAnswer, AskQuestion, BrainCard, BrainEvent, BrainUsage, CompactResult } from './events.js';
import { isNonUserSession } from './sessionId.js';
import { lastAssistantText } from './goal.js';
import { ClientAttachments } from './service/attachments.js';
import { PermissionApprovalService } from './service/permissionApproval.js';
import { GoalLoopService } from './service/goalLoop.js';
import { LiveSessionSpawner } from './service/spawner.js';
import { ConversationLifecycle } from './service/lifecycle.js';
import { BrainTurnRunner } from './service/turnRunner.js';
import type { BoundClientRequest, TurnRequest } from './service/turnRequest.js';
import { BrainStatusService } from './service/statusService.js';
import { exportBrainSession } from './session/exportSession.js';
import type { ExportFormat, SessionExport } from './session/exportSession.js';
import type { BrainDeps } from './brainDeps.js';
import type { ProcessInfo } from './processRegistry.js';
import type { BrainStreamSnapshot } from './session/liveEventReplay.js';
import { delegatedToolPolicy, type DelegatedExecutionScope } from './delegatedScope.js';
import { DEFAULT_BRAIN_LIMITS } from '../store/configStore.js';
import type { Model, Api } from '@earendil-works/pi-ai';
import { CANONICAL_THINKING_LEVELS, canonicalThinkingLevel } from './modelCapabilities.js';

export type { BrainDeps } from './brainDeps.js';



/** Per-user embedded brain lifecycle. Mirrors AdvisorService's shape so daemon wiring is familiar,
 *  but holds in-process PI AgentSessions (one per conversation) instead of spawning an external CLI.
 *  A thin facade over the focused units: session state (LiveSessionRegistry), assembly
 *  (BrainSessionFactory + LiveSessionSpawner), identities (IdentityResolver), addressing/respawns
 *  (ConversationLifecycle), the turn pipeline (BrainTurnRunner), permissions
 *  (PermissionApprovalService), the goal loop (GoalLoopService), read-only views (BrainStatusService),
 *  channel turns (ChannelSessionService) and platform adapters (PlatformOrchestrator).
 *
 *  TWO-TIER SESSION ADDRESSING. Conversations are reachable two ways:
 *  - POINTER-BASED (the web dock, platform surfaces): calls carry no session id and act on the user's
 *    ACTIVE conversation (`activeSessionId`). start() moves the pointer; everything else follows it.
 *  - SESSION-BOUND (the CLI): the client resolves ITS conversation once at start() and passes the id
 *    explicitly on every subsequent call (send/stream/compact/goal/…). Bound calls are ownership-checked,
 *    never READ the active pointer and never MOVE it — so two CLIs (or a CLI plus the dock) can work
 *    independent conversations concurrently without leaking events or hijacking each other's session.
 *  start() still sets the pointer even for a CLI start (opening a conversation anywhere makes it the
 *  web default); after that a bound client is immune to pointer movement. */
export class BrainService {
  /** All mutable live-session state: user sessions, active pointers, channel LRU and the per-key
   *  locks (PI sessions are single-conversation — concurrent prompt()/spawn calls on one session id
   *  queue up instead of corrupting turn state). */
  private sessions = new LiveSessionRegistry<LiveBrain>();
  /** Shared session assembly (store row + rehydrate + resource loader + PI session) — the same
   *  factory the elowen-exec brain workers use. */
  private factory: BrainSessionFactory;
  /** The ONE place turn identities (and the owner check) are minted. */
  private identity: IdentityResolver;
  private channelService: ChannelSessionService;
  private platforms: PlatformOrchestrator;
  /** Post-turn memory curator — built only when the memory deps are wired. Runs fire-and-forget from
   *  send() (owner chat), never awaited. */
  private curator?: MemoryCurator;
  /** Names a brand-new conversation from its first message with one cheap background inference (reuses the
   *  curator/categorizer model). No-ops when that model isn't configured — the provisional title stays. */
  private titler: ConversationTitler;
  /** Parked `ask_user_question` calls, shared by owner chat and channel sessions so `/brain/answer`
   *  (web/CLI) and Discord interactions resolve through one registry. */
  /** Operator-tuned brain limits, read live (Settings → Elowen AI → Limits); the built-in defaults when a
   *  minimal/test wiring omits the accessor. */
  private limits(): typeof DEFAULT_BRAIN_LIMITS { return this.d.brainLimits?.() ?? DEFAULT_BRAIN_LIMITS; }
  private elicitation = new ElicitationRegistry(() => this.limits().elicitationTimeoutMs);
  /** Live display cards (ctx.emitCard) per conversation — seeded to clients via status, kept current via
   *  the `card` event. Shared by owner chat and channel sessions. */
  private cards = new CardRegistry();
  /** Live client streams + long-lived session taps → the session each is attached to. */
  private attachments = new ClientAttachments();
  /** Effective tool permissions per turn + the approval channel + the session YOLO override. */
  private permissionSvc: PermissionApprovalService;
  /** The autonomous goal loop: /goal surface, continuation timers, post-turn judge. */
  private goals: GoalLoopService;
  /** Composes one live conversation (config + plugins + persona + tools) — the single spawn source. */
  private spawner: LiveSessionSpawner;
  /** Session addressing, start/resume resolution and every respawn path (rollover, hop, restart). */
  private lifecycle: ConversationLifecycle;
  /** The owner-chat turn pipeline (send). */
  private turnRunner: BrainTurnRunner;
  /** Read-only views: status, session lists, history, search, readiness. */
  private statusView: BrainStatusService;
  constructor(private d: BrainDeps) {
    // Mid-turn messages are STEERED into the running turn via PI's native queue (session.steer); PI fans
    // its transient backlog as `queue_update`, mapped to the `queue` snapshot event in the spawner.
    this.factory = new BrainSessionFactory({ store: d.store, createSession: d.createSession, resourceLoaderFactory: d.resourceLoaderFactory });
    this.identity = new IdentityResolver({ platformOwner: d.platformOwner, resolvePlatformUser: d.resolvePlatformUser, users: d.users });
    this.titler = new ConversationTitler({ store: d.store, inference: d.inference ?? (() => null), logger: logger('conversation-titler') });
    // Built before the channel service so it can share the SAME curator instance — channel and
    // owner-chat memory then run through one implementation.
    if (d.memoryStore && d.memoryService) {
      this.curator = new MemoryCurator({
        store: d.memoryStore, service: d.memoryService,
        inference: d.inference ?? (() => null), categorizer: d.memoryCategorizer,
        logger: logger('memory-curator'),
      });
    }
    // NOTE for all sub-service wiring below: passthrough deps are handed over as live getters/thunks
    // onto the ONE shared BrainDeps object, never captured by value — the original monolith read every
    // dep via `this.d.X` at call time, and tests (and live daemon rewiring) rely on late binding.
    this.permissionSvc = new PermissionApprovalService({
      get permissions() { return d.permissions; },
      get saveAlwaysAllow() { return d.saveAlwaysAllow; },
      get execAllowed() { return d.execAllowed; },
      elicitation: this.elicitation,
    });
    // The goal loop drives itself back through the facade (start/send) and the lifecycle (ensureLive)
    // via late-bound thunks — those units are constructed just below.
    this.goals = new GoalLoopService({
      store: d.store,
      ownedUserSession: (userId, sessionId) => this.lifecycle.ownedUserSession(userId, sessionId),
      activeSessionId: (userId) => this.lifecycle.activeSessionId(userId),
      attachedCount: (sessionId) => this.attachments.attachedCount(sessionId),
      ensureLive: (userId, sessionId, o) => this.lifecycle.ensureLive(userId, sessionId, o),
      start: (userId) => this.start(userId),
      send: (request) => this.send(request),
      defaultTurnBudget: () => this.limits().goalTurnBudget,
      goalMaxTurns: () => this.limits().goalMaxTurns,
      isYolo: (userId, sessionId) => this.permissionSvc.effectiveYolo(userId, this.sessions.get(sessionId)),
      publishGoal: (sessionId, goal) => {
        this.sessions.get(sessionId)?.replay.publish({ type: 'goal', goal });
      },
    });
    this.spawner = new LiveSessionSpawner({
      get config() { return d.config; },
      store: d.store,
      get authStorage() { return d.authStorage; },
      get users() { return d.users; },
      get prompts() { return d.prompts; },
      get url() { return d.url; },
      get cwd() { return d.cwd; },
      get projectPath() { return d.projectPath; },
      get userSettings() { return d.userSettings; },
      get activePersonality() { return d.activePersonality; },
      get agentName() { return d.agentName; },
      get maxSteps() { return d.maxSteps; },
      get memoryStore() { return d.memoryStore; },
      get memoryService() { return d.memoryService; },
      get memoryCategoryStore() { return d.memoryCategoryStore; },
      get memoryCategorizer() { return d.memoryCategorizer; },
      plugins: () => this.resolvePlugins(),
      factory: this.factory,
      sessionTaps: (sessionId) => this.attachments.sessionTaps.get(sessionId) ?? [],
    });
    this.lifecycle = new ConversationLifecycle({
      store: d.store, sessions: this.sessions, attachments: this.attachments,
      elicitation: this.elicitation, goals: this.goals,
      spawn: (o) => this.spawner.spawn(o),
      get policy() { return d.policy; },
      get userSettings() { return d.userSettings; },
      get projectModelPreference() { return d.projectModelPreference; },
      get setProjectModelPreference() { return d.setProjectModelPreference; },
      selectionAllowed: (userId, sel) => this.permissionSvc.selectionAllowed(userId, sel),
    });
    this.turnRunner = new BrainTurnRunner({
      store: d.store, sessions: this.sessions,
      lifecycle: this.lifecycle, goals: this.goals, permissions: this.permissionSvc,
      elicitation: this.elicitation, cards: this.cards, identity: this.identity,
      titler: this.titler, curator: this.curator,
      get prompts() { return d.prompts; },
      get users() { return d.users; },
      get userSettings() { return d.userSettings; },
      get memoryService() { return d.memoryService; },
      plugins: () => this.resolvePlugins(),
      get hookAudit() { return d.hookAudit; },
      get projectPath() { return d.projectPath; },
    });
    this.statusView = new BrainStatusService({
      store: d.store, sessions: this.sessions, attachments: this.attachments,
      elicitation: this.elicitation, cards: this.cards,
      lifecycle: this.lifecycle, permissions: this.permissionSvc,
      get config() { return d.config; },
      get authStorage() { return d.authStorage; },
      get createSession() { return d.createSession; },
      get cwd() { return d.cwd; },
    });
    this.channelService = new ChannelSessionService({
      registry: this.sessions, store: d.store, users: d.users,
      maxChannels: () => this.limits().channelSessionCap,
      spawn: (o) => this.spawner.spawn(o), // composition stays in the spawner — single source
      // Verified channel senders get memory too, keyed on their linked account and their own toggles.
      memoryService: d.memoryService, curator: this.curator, userSettings: d.userSettings,
      elicitation: this.elicitation, // one registry so Discord interactions resolve channel questions
      titler: this.titler, // name a brand-new channel conversation, same as owner chat
      permissions: d.permissions, // deny rules apply to channel turns too (asks follow unattendedAsks there)
    });
    this.platforms = new PlatformOrchestrator({
      plugins: () => this.resolvePlugins(),
      platformOwner: d.platformOwner,
      policyForProjects: d.policyForProjects,
      // A linked platform sender runs fully through their Elowen account: reuse the SAME per-user policy
      // resolver the owner web chat uses, plus their own tool deny-list.
      policyForUser: d.policy,
      disabledToolsFor: (userId) => d.users.get(userId)?.disabled_tools ?? [],
      identity: this.identity,
      channels: this.channelService,
      restart: () => this.restartHandler,
      // Origin-bound platform work (a cron wake-up scheduled from a user conversation): run the prompt
      // as a BOUND send into that conversation — the reply lands, streams and persists exactly where
      // the schedule was created. Ownership-verified here (the ONE place with the store): a vanished or
      // foreign session returns null and the orchestrator falls back to the channel path. The `session`
      // event is emitted only AFTER the send succeeded, so the caller (cron) can tell origin delivery
      // apart from a failed attempt and still deliver errors through its notify fallback.
      originSend: async (userId, sessionId, text, onEvent) => {
        const row = this.d.store.getSession(sessionId);
        if (!row || row.user_id !== userId || isNonUserSession(sessionId)) return null;
        await this.send({ userId, text, mode: 'build', session: sessionId });
        onEvent?.({ type: 'session', sessionId });
        return lastAssistantText(this.d.store, sessionId);
      },
    });
  }

  /** Admin daemon-restart handler for a platform `/restart` slash. Late-bound: it's built after the brain
   *  (it needs the systemd units + marker path), so bootstrap sets it once ready. Undefined ⇒ unavailable. */
  restartHandler?: (byUserId: number) => Promise<void>;

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.sessions.withLock(key, fn);
  }

  /** One-shot boot sweep for restart-zombie goals — see GoalLoopService.reconcileGoalsOnBoot. */
  reconcileGoalsOnBoot(): void {
    this.goals.reconcileGoalsOnBoot();
  }

  /** The model id the CURRENT config resolves to (readiness), or null — see BrainStatusService. */
  resolvableModel(): string | null {
    return this.statusView.resolvableModel();
  }

  /** One-turn connectivity probe on a throwaway session — see BrainStatusService.smokeTest. */
  async smokeTest(sel?: { providerId?: string; model?: string }): Promise<{ ok: boolean; model?: string; reply?: string; error?: string }> {
    return this.statusView.smokeTest(sel);
  }

  /** The daemon-wide plugin registry (undefined when plugins aren't wired at all). */
  private async resolvePlugins(): Promise<PluginRegistry | undefined> {
    return this.d.plugins?.get();
  }

  /** Manually compact a conversation (the /compact command): summarize the history so the context
   *  shrinks while the session stays usable. Targets the active conversation, or the caller's explicit
   *  `session` (a bound CLI). Serialized on the session lock (mirrors the channel variant) so it can't
   *  race an in-flight prompt(). A too-small/already-compacted session is a benign no-op
   *  (compacted:false), not an error. Throws only when nothing is running. */
  async compact(userId: number, session?: string): Promise<CompactResult> {
    const sessionId = session ? this.lifecycle.ownedUserSession(userId, session) : this.lifecycle.activeSessionId(userId);
    if (!this.sessions.get(sessionId)) throw new Error('brain not started');
    return this.serial(sessionId, async () => {
      const live = this.sessions.get(sessionId);
      if (!live) throw new Error('brain not started');
      live.interactedAt = Date.now(); // a manual compact is a deliberate touch — don't idle-roll it over
      // A real compaction fires PI's `compaction_end`, which the factory's session subscription mirrors
      // into the store and the spawner fans `compacted` to attached clients — persistence + notify ride the
      // event, not this call. A no-op (session too small) emits no result and leaves the store untouched.
      const result = await runCompaction(live.session);
      result.usage = withDescendantUsage(result.usage, this.d.store.descendantUsage(live.sessionId));
      return result;
    });
  }

  /** Stop the streaming turn (the Esc key in chat clients) — on the active conversation, or on the
   *  caller's explicit `session` (a bound CLI). The agent settles into agent_end → the idle event, so
   *  subscribed clients wind down on their own. */
  async abort(userId: number, session?: string): Promise<void> {
    const b = session ? this.sessions.get(this.lifecycle.ownedUserSession(userId, session)) : this.lifecycle.activeLive(userId);
    if (!b) throw new Error('brain not started');
    // Fence before taking the child snapshot. Otherwise an idle drill-in continuation can register a
    // fresh child between childrenOf() and clearChildren(), escaping this stop tree.
    this.sessions.beginParentAbort(b.sessionId);
    try {
      this.goals.cancelGoalContinuation(b.sessionId);
      // Esc/stop = the user bails: drop every mid-turn steered message still pending in PI's queue so an
      // interrupted turn doesn't deliver words the user meant for the turn they just killed.
      b.session.clearQueue();
      // A parked ask_user_question must fail cleanly when the turn is aborted, else the tool Promise
      // (and the awaited prompt()) would hang forever. Reject before aborting the PI session.
      if (b.sessionId) this.elicitation.cancelForSession(b.sessionId, 'aborted');
      // Cascade into running delegations: without this the child keeps working (and burning tokens)
      // after the parent turn died — and the user's interrupt looks like it didn't take.
      await Promise.all(this.sessions.childrenOf(b.sessionId)
        .filter((child) => child.startsWith('brain-ch-'))
        .map((child) => this.channelService.abort(child.slice('brain-ch-'.length))));
      this.sessions.clearChildren(b.sessionId);
      await b.session.abort();
    } finally {
      this.sessions.endParentAbort(b.sessionId);
    }
  }

  /** A CLI is closing: stop its bound run and release the live PI session when it is the last attached
   *  client. History stays in SQLite and can be resumed; another terminal/web stream keeps the shared
   *  live session alive. Idempotent for an already-stopped conversation. */
  async stopSession(userId: number, session?: string, clientId?: string, clientGeneration?: number): Promise<{ stopped: boolean; disposed: boolean }> {
    // Consume the authenticated client's attachment FIRST. Its binding follows idle rollover inside the
    // daemon, so it is more authoritative than the (possibly pre-rollover) id the CLI last observed.
    // Releasing invokes only this client's stream disposer; every other attachment remains counted.
    const released = clientId
      ? this.attachments.release(userId, clientId, clientGeneration)
      : { accepted: true as const, sessionId: undefined };
    // A delayed stop from generation N must not abort a newer N+1 selection owned by the same CLI id.
    if (!released.accepted) return { stopped: false, disposed: false };
    const bound = released.sessionId;
    // A bootstrap/start failure can issue a generation stop before the daemon ever created a binding.
    // `release()` has still tombstoned that generation (so a delayed start cannot resurrect it), but with
    // no stable target and no explicit session body it must not guess the user's unrelated active session.
    if (clientId && !bound && !session) return { stopped: false, disposed: false };
    const cleanUp = async (sessionId: string): Promise<{ stopped: boolean; disposed: boolean }> => {
      const live = this.sessions.get(sessionId);
      if (!live) return { stopped: false, disposed: false };
      try { await this.abort(userId, sessionId); } catch { /* already idle/settled */ }
      // The caller's own attachment was removed above, so zero now unambiguously means no other observer.
      // Legacy callers without a stable id retain the conservative behavior: only an already-detached
      // stream can make the count zero; we never guess which remaining listener belongs to the caller.
      const disposable = this.attachments.attachedCount(sessionId) === 0;
      if (disposable) {
        this.goals.cancelGoalContinuation(sessionId);
        this.elicitation.cancelForSession(sessionId, 'client closed');
        this.cards.clearSession(sessionId);
        this.sessions.dispose(sessionId);
      }
      return { stopped: true, disposed: disposable };
    };
    // Reserve the bare session lock BEFORE any wait/ownership lookup. `settled(bound)` outside this lock
    // can race a replacement start (and can deadlock when that lifecycle holder waits on this cleanup).
    // Once queued here, a start either finishes first and this stops that exact live instance, or waits
    // behind us and creates a fresh one only after the old instance was disposed.
    if (bound) {
      return this.serial(bound, async () => cleanUp(this.lifecycle.ownedUserSession(userId, bound)));
    }
    const sessionId = session ? this.lifecycle.ownedUserSession(userId, session) : this.lifecycle.activeSessionId(userId);
    return this.serial(sessionId, async () => cleanUp(sessionId));
  }

  /** Settle a parked `ask_user_question` with the user's picks (from POST /brain/answer or a Discord
   *  interaction). Deliberately NOT serialized: the parked turn holds the session lock, so resolving
   *  through the lock would deadlock — it just resolves the registry Promise directly. Returns whether
   *  a pending question matched (false for an unknown/expired id — tolerated). */
  answerQuestion(id: string, answers: AskAnswer[], ownerUserId?: number): boolean {
    // When answered via the owner HTTP route, authorize: the caller may only settle a question parked in
    // their OWN owner-chat conversation — never someone else's, and never a shared channel session (those
    // resolve in-process from the platform adapter, which gates the interaction itself). Omitted for the
    // trusted in-process path (Discord), which has already authorized the responder.
    if (ownerUserId !== undefined) {
      const sid = this.elicitation.sessionOf(id);
      if (!sid || isNonUserSession(sid)) return false;
      const row = this.d.store.getSession(sid);
      if (!row || row.user_id !== ownerUserId) return false;
    }
    return this.elicitation.answer(id, answers);
  }

  /** Switch a conversation to another configured model (/model) — see ConversationLifecycle. */
  async switchModel(userId: number, sel: { provider?: string; model?: string }, session?: string): Promise<{ model: string }> {
    return this.lifecycle.switchModel(userId, sel, session);
  }

  /** Set the reasoning effort of the ACTIVE conversation live (the /think command) — PI applies it to
   *  the running session without a respawn, unlike a model switch. A level the current model doesn't
   *  support is clamped by PI. Returns the effective level. Session-scoped (like /model): the saved
   *  per-user default in Account → CLI is unchanged. */
  async setThinkingLevel(userId: number, level: string, session?: string): Promise<{ thinkingLevel: string }> {
    const b = session ? this.sessions.get(this.lifecycle.ownedUserSession(userId, session)) : this.lifecycle.activeLive(userId);
    if (!b) throw new Error('brain not started');
    const sess = b.session as { setThinkingLevel?: (l: string) => void; thinkingLevel?: string; getAvailableThinkingLevels?: () => string[] };
    const model = b.session.model as Model<Api> | undefined;
    const canonical = model ? canonicalThinkingLevel(model, level) : level;
    const available = new Set(sess.getAvailableThinkingLevels?.() ?? CANONICAL_THINKING_LEVELS);
    if (!available.has(canonical)) throw new Error(`model does not support reasoning effort "${level}"`);
    sess.setThinkingLevel?.(canonical);
    b.thinkingLevel = canonical;
    b.interactedAt = Date.now(); // a reasoning-effort change is a deliberate touch — don't idle-roll it over
    return { thinkingLevel: (sess.thinkingLevel as string) ?? canonical };
  }

  /** Toggle ChatGPT OAuth priority processing for one live conversation. */
  setFast(userId: number, on?: boolean, session?: string): { fast: boolean; fastAvailable: boolean } {
    const b = session ? this.sessions.get(this.lifecycle.ownedUserSession(userId, session)) : this.lifecycle.activeLive(userId);
    if (!b) throw new Error('brain not started');
    if (!b.fastAvailable) throw new Error('Fast mode is available only for OpenAI OAuth models');
    b.requestProfile.fast = on ?? !b.requestProfile.fast;
    b.interactedAt = Date.now();
    return { fast: b.requestProfile.fast, fastAvailable: true };
  }

  /** Chat-client status — of the active conversation, or of the caller's explicit `session` (a bound
   *  CLI) — see BrainStatusService.status. */
  status(userId: number, session?: string): { running: boolean; sessionId: string | null; title: string; model: string; usage: BrainUsage | null; thinkingLevel: string; thinkingLevels: string[]; thinkingLevelLabels: Record<string, string>; fast: boolean; fastAvailable: boolean; pendingAsk: { id: string; questions: AskQuestion[]; kind?: 'approval' } | null; cards: BrainCard[]; queued: { id: string; text: string }[]; yolo: boolean } {
    return this.statusView.status(userId, session);
  }

  /** The caller's pending mid-turn message backlog (PI's transient steered + follow-up snapshot) — of the
   *  active conversation, or of the caller's explicit `session` (a bound CLI). Empty when nothing is
   *  pending or no conversation is live. */
  queueList(userId: number, session?: string): { id: string; text: string }[] {
    const sessionId = session ? this.lifecycle.ownedUserSession(userId, session) : this.sessions.activeIdFor(userId);
    const live = sessionId ? this.sessions.get(sessionId) : undefined;
    return live ? queueItems(live.session.getSteeringMessages(), live.session.getFollowUpMessages()) : [];
  }

  /** Remove ONE pending mid-turn message (the CLI ctrl+x / the web × button). PI's steering queue holds
   *  bare strings with no ids and offers only a clear-all, so we target by POSITION (the same positional
   *  id `queueItems` hands clients): drain the queue, then re-queue everything except the targeted index.
   *  Re-queues from our image-carrying mirror (queuedSteer/queuedFollowUp), NOT PI's text-only accessors —
   *  PI's clearQueue drops image attachments, so re-steering from text alone would strip the surviving
   *  messages' images. An out-of-range id is a no-op. Returns whether a message was actually removed. */
  queueRemove(userId: number, id: string, session?: string): boolean {
    const sessionId = session ? this.lifecycle.ownedUserSession(userId, session) : this.sessions.activeIdFor(userId);
    const live = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!live) return false;
    const steering = live.queuedSteer ?? [];
    const followUp = live.queuedFollowUp ?? [];
    const idx = Number(id);
    if (!Number.isInteger(idx) || idx < 0 || idx >= steering.length + followUp.length) return false;
    // Snapshot WITH images before clearQueue empties both PI's queue and (via queue_update) our mirror.
    const combined = [
      ...steering.map((m) => ({ kind: 'steer' as const, ...m })),
      ...followUp.map((m) => ({ kind: 'followUp' as const, ...m })),
    ];
    live.session.clearQueue();
    // Re-queue in the same order, dropping the positional target, preserving each survivor's images.
    // `steer`/`followUp` only enqueue while the turn is streaming (a queue only exists mid-turn), so
    // nothing runs a fresh turn; enqueueMirrored keeps the mirror in step.
    combined.forEach((m, i) => { if (i !== idx) void enqueueMirrored(live, m.kind, m.text, m.images); });
    return true;
  }

  /** Flip the SESSION-scoped YOLO override (the CLI `/yolo` command) — see PermissionApprovalService.
   *  Throws when no conversation is live. */
  setYolo(userId: number, on?: boolean, session?: string): { yolo: boolean } {
    const b = session ? this.sessions.get(this.lifecycle.ownedUserSession(userId, session)) : this.lifecycle.activeLive(userId);
    if (!b) throw new Error('brain not started');
    return this.permissionSvc.setYolo(userId, b, on);
  }

  /** Delete one of the user's stored conversations (never a channel session, never someone else's).
   *  A live session is disposed first; deleting the active conversation just clears the pointer —
   *  the next start() falls back to the most recent remaining one. */
  deleteSession(userId: number, sessionId: string): void {
    const row = this.d.store.getSession(sessionId);
    if (!row || row.user_id !== userId || isNonUserSession(sessionId)) throw new Error('unknown session');
    this.elicitation.cancelForSession(sessionId, 'conversation deleted'); // release a parked turn before dropping its session
    this.goals.cancelGoalContinuation(sessionId);
    this.cards.clearSession(sessionId);
    this.sessions.dispose(sessionId);
    if (this.sessions.activeIdFor(userId) === sessionId) this.sessions.clearActive(userId);
    this.d.store.deleteSession(sessionId);
  }

  renameSession(userId: number, sessionId: string, title: string): { id: string; title: string } {
    const row = this.d.store.getSession(sessionId);
    const clean = title.trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!row || row.user_id !== userId || isNonUserSession(sessionId)) throw new Error('unknown session');
    if (!clean) throw new Error('title cannot be empty');
    this.d.store.renameSession(sessionId, clean);
    return { id: sessionId, title: clean };
  }

  goalStatus(userId: number, session?: string): BrainGoalRow | null {
    return this.goals.goalStatus(userId, session);
  }

  async setGoal(userId: number, text: string, opts?: { draft?: boolean; turnBudget?: number }, session?: string): Promise<BrainGoalRow> {
    return this.goals.setGoal(userId, text, opts, session);
  }

  goalAction(userId: number, action: 'pause' | 'resume' | 'clear', session?: string): BrainGoalRow | null {
    return this.goals.goalAction(userId, action, session);
  }

  subgoal(userId: number, action: 'add' | 'remove' | 'clear', value?: string | number, session?: string): BrainGoalRow {
    return this.goals.subgoal(userId, action, value, session);
  }

  /** The user's conversations with live/active/attached flags — see BrainStatusService.listSessions. */
  listSessions(userId: number): { id: string; title: string; model: string; updated_at: string; running: boolean; active: boolean; attached: number }[] {
    return this.statusView.listSessions(userId);
  }

  /** Fulltext search across the user's stored conversations — see BrainStatusService.searchMessages. */
  searchMessages(userId: number, query: string): BrainSearchHit[] {
    return this.statusView.searchMessages(userId, query);
  }

  /** ADMIN session-management view (the sessions/ panel) — see BrainStatusService.listManagedSessions. */
  listManagedSessions(userId: number): { id: string; title: string; model: string; updated_at: string; running: boolean; active: boolean; kind: 'conversation' | 'channel' | 'task'; tokens: number }[] {
    return this.statusView.listManagedSessions(userId);
  }

  /** Delete ANY of the owner's brain sessions by id (admin panel) — disposing a live conversation or
   *  channel session first. Deliberately bypasses the isNonUserSession guard: this IS the management
   *  surface. Returns how many were deleted (0 or 1). */
  deleteManagedSession(userId: number, id: string): number {
    const row = this.d.store.getSession(id);
    if (!row || row.user_id !== userId) return 0;
    this.elicitation.cancelForSession(id, 'session deleted');
    this.goals.cancelGoalContinuation(id);
    if (id.startsWith('brain-ch-')) this.sessions.channelDispose(id.slice('brain-ch-'.length));
    else if (this.sessions.has(id)) this.sessions.dispose(id);
    this.d.store.deleteSession(id);
    return 1;
  }

  /** Delete ALL of the owner's brain sessions (the panel's "delete everything" — the client confirms).
   *  Returns the count removed. */
  deleteAllManagedSessions(userId: number): number {
    let n = 0;
    for (const s of this.d.store.listSessions(userId)) n += this.deleteManagedSession(userId, s.id);
    return n;
  }

  /** Start (or resume) a conversation — see ConversationLifecycle.start. */
  async start(userId: number, opts?: { provider?: string; model?: string; session?: string; fresh?: boolean; cwd?: string; clientId?: string; clientGeneration?: number }): Promise<{ sessionId: string }> {
    return this.lifecycle.start(userId, opts);
  }

  /** Follow the user's ACTIVE conversation live — see ConversationLifecycle.subscribe. */
  subscribe(userId: number, listener: (e: BrainEvent) => void, clientId?: string, clientGeneration?: number): () => void {
    return this.lifecycle.subscribe(userId, listener, clientId, clientGeneration);
  }

  /** Follow one of the CALLER'S OWN sessions live, by explicit id — see ConversationLifecycle.tapSession. */
  tapSession(userId: number, sessionId: string, listener: (e: BrainEvent) => void, clientId?: string, clientGeneration?: number): () => void {
    return this.lifecycle.tapSession(userId, sessionId, listener, clientId, clientGeneration);
  }

  /** Install a fixed-session tap and capture its durable+live snapshot without yielding. The caller
   *  must buffer listener events until it has written `snapshot`; because both operations are
   *  synchronous, every event belongs exactly once (inside the snapshot or after it). */
  tapSessionSnapshot(userId: number, sessionId: string, listener: (e: BrainEvent) => void, clientId?: string, clientGeneration?: number): { off: () => void; snapshot: BrainStreamSnapshot } {
    // A reconnect can carry the pre-rollover id while its stable client binding has already moved to the
    // fresh session. Resolve once up front so BOTH the tap and atomic history/journal snapshot name the
    // same target; otherwise the tap follows fresh but the first frame accidentally hydrates old history.
    const targetSessionId = this.lifecycle.resolveStreamSession(userId, sessionId, clientId, clientGeneration);
    const off = this.lifecycle.tapSession(userId, targetSessionId, listener, clientId, clientGeneration);
    try { return { off, snapshot: this.statusView.streamSnapshot(userId, targetSessionId) }; }
    catch (error) { off(); throw error; }
  }

  /** Resolve the durable, immutable scope for an owner drill-in. Kept synchronous so the HTTP route can
   * reject a legacy/corrupt child before it fire-and-forgets the actual long-running continuation. */
  private delegatedContinuation(userId: number, sessionId: string): {
    row: { id: string; user_id: number; parent_session_id: string | null };
    parentSessionId: string;
    scope: DelegatedExecutionScope;
  } {
    const row = this.d.store.getSession(sessionId);
    if (!row || row.user_id !== userId) throw new Error('unknown session');
    if (!sessionId.startsWith('brain-ch-subagent-')) throw new Error('not a sub-agent session');
    const parentSessionId = row.parent_session_id;
    if (!parentSessionId) throw new Error('invalid parent session');
    const parent = this.d.store.getSession(parentSessionId);
    if (!parent || parent.user_id !== userId) throw new Error('invalid parent session');
    const scope = this.d.store.delegatedAccessFor(sessionId);
    if (!scope) throw new Error('delegated access unavailable');
    return { row, parentSessionId, scope };
  }

  /** Synchronous route preflight for `/brain/subagent/send`: a legacy child with no immutable scope
   * must return 409 now, not be silently swallowed by the route's detached promise. */
  preflightSubagentSend(userId: number, sessionId: string): void {
    this.delegatedContinuation(userId, sessionId);
  }

  /** The owner talking INTO a delegated sub-agent's session: steers the message into the child's
   *  RUNNING turn (mid-run course correction), or runs it as a fresh turn when the child is idle
   *  (continue the conversation after it finished). Restricted to the caller's OWN
   *  `brain-ch-subagent-*` sessions — the child executes with access inherited from the caller's own
   *  delegation, so this can never escalate; shared platform channels are deliberately NOT reachable
   *  here (steering another member's turn would mix privileges). */
  async sendToSubagent(userId: number, sessionId: string, text: string): Promise<void> {
    const { row, parentSessionId, scope } = this.delegatedContinuation(userId, sessionId);
    const policy = scope.admin
      ? { allowedProjectIds: 'all' as const, allowedPaths: () => [] }
      : this.d.policyForProjects?.(scope.projectIds)
        ?? { allowedProjectIds: new Set(scope.projectIds), allowedPaths: () => [] };
    const deniedTools = this.d.users.get(userId)?.disabled_tools ?? [];
    await this.channelService.send({
      channelId: sessionId.slice('brain-ch-'.length),
      ownerUserId: row.user_id,
      // A drill-in continuation is a new child run, not a standalone channel turn. Preserve the durable
      // edge so parent stop/status and eviction guards keep owning it even after the child respawns.
      parentSessionId,
      policy,
      delegatedAccess: scope,
      promptAppend: scope.promptAppend,
      trusted: scope.admin,
      // The captured allow/deny policy remains authoritative; current account disabled tools may only add
      // a deny. A mid-run steer still executes under the already-running child's original turn scope.
      toolPolicy: delegatedToolPolicy(scope, deniedTools),
      identity: this.identity.forDelegatedTurn(scope, row.user_id),
      ownerSteer: true,
    }, text);
  }

  /** Run one user turn — see BrainTurnRunner.send. `display` is the client's clean rendering of the
   *  message (before @mention/prompt expansion) that the authoritative `user` echo shows; absent → the
   *  model-facing text is echoed. */
  /** Whether `userId` is the instance operator (the owner). Exposed so owner-only API surfaces — e.g. the
   *  background-process routes, which read/kill children of the owner-only terminal tools — gate on the same
   *  notion the tools do, not merely `is_admin` (a second admin is admin-but-not-owner). */
  isOwner(userId: number | undefined): boolean {
    return this.identity.isOwner(userId);
  }

  /** Push a background-process snapshot to the OWNER's live client streams (the CLI/web process panel),
   *  so it refreshes out of turn on every spawn/exit/kill. Wired to the process registry's change
   *  listener in the daemon. Owner-only: a command line can carry a secret, so the event is delivered
   *  ONLY to streams attached to the owner's own sessions, never a second admin's. */
  broadcastProcesses(processes: ProcessInfo[]): void {
    const event: BrainEvent = { type: 'process', processes };
    for (const [listener, sessionId] of this.attachments.clientStreams) {
      if (this.isOwner(this.d.store.getSession(sessionId)?.user_id)) listener(event);
    }
  }

  async send(request: TurnRequest): Promise<void> {
    return this.turnRunner.send(request);
  }

  /** Start a user turn and expose its two real lifecycle boundaries. `admitted` resolves only after the
   * prompt is durable and its authoritative user event has been published; `completed` covers the full
   * model/tool turn. This lets HTTP acknowledge safely without holding the request for a long turn. */
  startSend(request: TurnRequest): { admitted: Promise<string>; completed: Promise<void> } {
    let resolveAdmitted!: (sessionId: string) => void;
    let rejectAdmitted!: (error: unknown) => void;
    let admissionSettled = false;
    const admitted = new Promise<string>((resolve, reject) => {
      resolveAdmitted = resolve;
      rejectAdmitted = reject;
    });
    const completed = this.turnRunner.send({
      ...request,
      onAdmitted: (sessionId) => {
        if (admissionSettled) return;
        admissionSettled = true;
        resolveAdmitted(sessionId);
      },
    }).then(
      () => {
        if (admissionSettled) return;
        admissionSettled = true;
        rejectAdmitted(new Error('turn completed before admission'));
      },
      (error) => {
        if (!admissionSettled) {
          admissionSettled = true;
          rejectAdmitted(error);
        }
        throw error;
      },
    );
    return { admitted, completed };
  }

  /** Surface a failure that happened after HTTP admission through the same ordered replay stream the
   * TUI/headless client already consumes. Returns false only if teardown removed the live session. */
  publishAcceptedSendFailure(sessionId: string, error: unknown): boolean {
    const live = this.sessions.get(sessionId);
    if (!live) return false;
    const message = error instanceof Error ? error.message : String(error);
    live.replay.publish({ type: 'error', message: message || 'accepted turn failed' });
    return true;
  }

  /** Synchronous admission check for the HTTP send route. Model turns may run for minutes; the route
   * acknowledges immediately after this check so reverse-proxy timeouts cannot turn a healthy streamed
   * tool-heavy response into a client-side `fetch failed` transcript row. */
  preflightSend(userId: number, session?: string, client?: BoundClientRequest): string {
    const target = session
      ? this.lifecycle.ownedUserSession(userId, session)
      : this.lifecycle.activeSessionId(userId);
    const row = this.d.store.getSession(target);
    if (!row || row.user_id !== userId) throw new Error('brain not started for user');
    if (client && !this.lifecycle.authorizeClientRequest(userId, client.id, client.generation, target)) {
      throw new Error('client session has stopped');
    }
    return target;
  }

  /** Restart a user's live session so changed settings apply — see ConversationLifecycle.restart. */
  async restart(userId: number): Promise<void> {
    return this.lifecycle.restart(userId);
  }

  /** A user changed their active personality profile: respawn so the new persona chunk lands in the
   *  system prompt. The user's own owner-chat session restarts (per-user, safe), AND every channel
   *  session is dropped so a Discord room respawns on the owner's fresh 'discord' persona — the channel
   *  session is owner-anchored and shared, so it must not keep the stale persona. History rehydrates from
   *  SQLite on respawn. Rare operation; serialized on its own key so it never interleaves a reload. */
  async applyPersonalityChange(userId: number): Promise<void> {
    await this.serial(`personality-${userId}`, async () => {
      await this.restart(userId);
      this.sessions.channelDisposeAll();
    });
  }

  /** Invalidate the shared plugin registry and restart every live session — called when the admin flips
   *  a plugin on/off so the change applies without a daemon restart. Channel sessions are simply dropped;
   *  the next inbound message re-opens them with the fresh registry. The shared invalidation also covers
   *  the elowen-exec brain workers — their next launch composes from the fresh registry. */
  async reloadPlugins(): Promise<void> {
    // Serialized: two rapid plugin toggles must not interleave stopAll()/startAll() and leave
    // duplicate connected adapters (a distinct lock key from any session, so it never blocks a turn).
    await this.serial('plugins-reload', async () => {
      // Every live session is about to be torn down — release any parked ask_user_question across all of
      // them so a pending question can't stall the reload (or leave a turn hanging on a disposed session).
      this.elicitation.cancelAll('plugins reloaded');
      // Let plugins observe the reload boundary. Observational only (fail-open, no mutation) — fires on
      // the CURRENT registry's hooks before we swap it out.
      const before = await this.d.plugins?.get();
      if (before) await new PluginHookBus({ hooks: before.hooks }).emit('plugin.reload.before', {});
      this.d.plugins?.invalidate();
      for (const userId of this.sessions.activeUserIds()) await this.restart(userId);
      // Non-active live sessions just drop; they respawn with the new registry on next resume.
      const activeIds = this.sessions.activeIds();
      for (const [id] of this.sessions.liveEntries()) {
        if (!activeIds.includes(id)) this.sessions.dispose(id);
      }
      this.sessions.channelDisposeAll();
      // Platform adapters were built by the old registry — disconnect them and start the fresh set.
      this.platforms.stopAll();
      await this.platforms.startAll();
      // reload.after fires against the freshly rebuilt registry so plugins can re-prime state.
      const after = await this.d.plugins?.get();
      if (after) await new PluginHookBus({ hooks: after.hooks }).emit('plugin.reload.after', {});
    });
  }

  /** Push a proactive message out through the platform adapters (cron/tick echoes). */
  async notify(text: string, channelId?: string): Promise<void> {
    await this.platforms.notify(text, channelId);
  }

  /** Start every plugin-contributed platform adapter — see PlatformOrchestrator. */
  async startPlatforms(log?: { info(m: string): void; error(m: string): void }): Promise<void> {
    await this.platforms.startAll(log);
  }

  /** Send one channel message (e.g. a Discord mention) — see ChannelSessionService. */
  async channelSend(opts: ChannelSendOpts, text: string): Promise<string> {
    return this.channelService.send(opts, text);
  }

  stop(userId: number): void {
    this.lifecycle.stop(userId);
  }

  /** The user's stored ACTIVE conversation, shaped for display — see BrainStatusService.history. */
  history(userId: number): BrainMessageView[] {
    return this.statusView.history(userId);
  }

  /** ANY of the owner's stored sessions, shaped for display — see BrainStatusService.messagesOf. */
  messagesOf(userId: number, sessionId: string): BrainMessageView[] {
    return this.statusView.messagesOf(userId, sessionId);
  }

  /** Export one of the caller's OWN conversations (owner-scoped exactly like messagesOf) as a
   *  self-contained HTML transcript or a JSONL session file. Reads history from the store and renders
   *  through PI's own exporter into a private temp dir — no live PI session required. Throws for an
   *  unknown or foreign session; the returned handle's cleanup() removes the temp dir. */
  exportSession(userId: number, sessionId: string, format: ExportFormat): Promise<SessionExport> {
    const row = this.d.store.getSession(sessionId);
    if (!row || row.user_id !== userId) throw new Error('unknown session');
    return exportBrainSession({ store: this.d.store, sessionId, cwd: row.work_dir || process.cwd(), title: row.title, format });
  }
}
