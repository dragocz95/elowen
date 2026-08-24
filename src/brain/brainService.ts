import { randomUUID } from 'node:crypto';
import type { PluginRegistry } from '../plugins/registry.js';
import { PluginHookBus } from '../plugins/hookBus.js';
import { PluginServiceRunner } from '../plugins/serviceRunner.js';
import type { DelegatedContinueResult, ServiceNotice, SubagentProgressEvent } from '../plugins/api.js';
import { ElicitationRegistry } from './elicitation.js';
import { CardRegistry } from './cards.js';
import type { BrainSearchHit, BrainGoalRow } from '../store/brainStore.js';
import { MemoryCurator } from './memoryCurator.js';
import { ConversationTitler } from './conversationTitler.js';
import { logger } from '../shared/logger.js';
import { BrainSessionFactory, resolveAutoCompactPct } from './session/factory.js';
import { IdentityResolver } from './identity.js';
import { LiveSessionRegistry } from './session/liveRegistry.js';
import type { LiveBrain, QueuedMsg } from './session/liveBrain.js';
import { DEFAULT_AUTO_COMPACT_PCT } from './session/liveBrain.js';
import { enqueueMirrored } from './session/queueMirror.js';
import { ChannelSessionService } from './channels.js';
import type { ChannelSendOpts, DelegatedSteerOutcome } from './channels.js';
import { PlatformOrchestrator } from './platforms.js';
import { delegatedChannelSendOpts, type DelegatedTurnRequest } from './delegatedTurn.js';
import { SubagentDispatch } from '../subagent/dispatch.js';
import { lastAssistantTextIn, type BrainMessageView } from './messageView.js';
import { runCompaction, withDescendantUsage } from './events.js';
import type { AskAnswer, BrainEvent, CompactResult } from './events.js';
import { isNonUserSession, isOwnedUserSession, isSubagentSession, defaultUserSessionId, freshUserSessionId, channelSessionId, archivedChannelSessionId } from './sessionId.js';
import { lastAssistantText } from './goal.js';
import { ClientAttachments } from './service/attachments.js';
import { DelegatedSessionService } from './service/delegatedSession.js';
import { IdleSessionClock } from './service/liveSessionReaper.js';
import { PermissionApprovalService } from './service/permissionApproval.js';
import { GoalLoopService } from './service/goalLoop.js';
import { LiveSessionSpawner } from './service/spawner.js';
import { ConversationLifecycle } from './service/lifecycle.js';
import { recordSessionEvent, scheduleReasoningMarker } from './service/sessionEvents.js';
import { clientDir } from './service/workDir.js';
import { BrainTurnRunner } from './service/turnRunner.js';
import type { BoundClientRequest, TurnRequest } from './service/turnRequest.js';
import { BrainStatusService } from './service/statusService.js';
import type { SessionListItem, SessionPage, SessionPageOpts, MessagePage, MessagePageOpts, BrainStatusView, ManagedSessionView } from './service/statusService.js';
import type {
  BrainContextBreakdown, BrainDebugLegacyTranscriptPage, BrainDebugPage, BrainDebugPayloadPage,
  BrainDebugRawPayload, BrainDebugRequestDetail, BrainDebugRequestItem, BrainDebugSegmentPayload,
  BrainDebugSessionItem, BrainDebugSessionPage, BrainForkedSession,
} from '../shared/wireContract.js';
import type { ProviderRequestDebugRequestFilters, ProviderRequestDebugSessionFilters } from '../store/providerRequestStore.js';
import { SessionTeardownService } from './service/sessionTeardown.js';
import { SessionProcessService } from './service/sessionProcesses.js';
import { SessionQueueService } from './service/sessionQueue.js';
import { exportBrainSession } from './session/exportSession.js';
import type { ExportFormat, SessionExport } from './session/exportSession.js';
import { toolAuthorityForUser } from './brainDeps.js';
import type { BrainDeps } from './brainDeps.js';
import { processRegistry, type ProcessInfo } from './processRegistry.js';
import type { BrainStreamSnapshot } from './session/liveEventReplay.js';
import { DEFAULT_BRAIN_LIMITS } from '../store/configStore.js';
import type { Model, Api } from '@earendil-works/pi-ai';
import { CANONICAL_THINKING_LEVELS, canonicalThinkingLevel } from './modelCapabilities.js';
import { collapseWhitespace } from '../shared/text.js';

export type { BrainDeps } from './brainDeps.js';

/** How long a reload attempt waits for running work to drain before giving up on THIS attempt. Waiting
 *  closes admission (that is what lets the work drain at all), so the budget is the length of a request
 *  the whole instance would spend refusing new turns — it is deliberately short. An idle instance is
 *  quiescent on the first poll and swaps immediately; on a busy one no amount of waiting helps, because
 *  the deferred flag re-arms and the next settled turn applies the change and announces it. */
const PLUGIN_RELOAD_DRAIN_MS = 2_000;
const PLUGIN_RELOAD_POLL_MS = 100;

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
  /** Plugin-contributed background services + boot reconciles — cycled with the platforms. */
  private pluginServices: PluginServiceRunner;
  /** Where a delegated turn EXECUTES: on this event loop, or in the forked sub-agent runner. */
  private subagents: SubagentDispatch;
  /** Set only in the sub-agent runner — see attachDelegatedEdgeReporter. */
  private delegatedEdgeReporter?: (parentSessionId: string, childSessionId: string, running: boolean) => void;
  /** Post-turn memory curator — built only when the memory deps are wired. Runs fire-and-forget from
   *  send() (owner chat), never awaited. */
  private curator?: MemoryCurator;
  /** Names a brand-new conversation from its first message with one cheap background inference (reuses the
   *  curator/categorizer model). No-ops when that model isn't configured — the provisional title stays. */
  private titler: ConversationTitler;
  /** Parked `AskUserQuestion` calls, shared by owner chat and channel sessions so `/brain/answer`
   *  (web/CLI) and Discord interactions resolve through one registry. */
  /** Operator-tuned brain limits, read live (Settings → Elowen AI → Limits); the built-in defaults when a
   *  minimal/test wiring omits the accessor. */
  private limits(): typeof DEFAULT_BRAIN_LIMITS { return this.d.brainLimits?.() ?? DEFAULT_BRAIN_LIMITS; }
  private elicitation = new ElicitationRegistry(() => this.limits().elicitationTimeoutMs);
  /** Display cards (ctx.emitCard) per conversation — seeded to clients via status, kept current via the
   *  `card` event. Shared by owner chat and channel sessions. Store-backed, so a panel (the todo
   *  checklist) survives closing the conversation and the daemon restarting, not just an SSE reconnect. */
  private cards = new CardRegistry(() => this.d.store);
  /** Live client streams + long-lived session taps → the session each is attached to. */
  private attachments = new ClientAttachments();
  /** How long each live conversation has been continuously unwatched AND idle — the reaper's clock. */
  private readonly idleClock = new IdleSessionClock();
  /** Effective tool permissions per turn + the approval channel + the session YOLO override. */
  private permissionSvc: PermissionApprovalService;
  /** The autonomous goal loop: /goal surface, continuation timers, post-turn judge. */
  private goals: GoalLoopService;
  /** Composes one live conversation (config + plugins + persona + tools) — the single spawn source. */
  private spawner: LiveSessionSpawner;
  /** Latched by {@link beginDrain} on shutdown; gates new turns so the drain can converge. */
  private draining = false;
  /** Reversible admission gate while a hot plugin reload waits for existing work to finish. Unlike shutdown
   *  drain this returns to false after the registry swap. A counter keeps the gate closed across queued reloads. */
  private pluginReloadWaiters = 0;
  private reloadingPlugins = false;
  /** Session addressing, start/resume resolution and every respawn path (rollover, hop, restart). */
  private lifecycle: ConversationLifecycle;
  /** The owner-chat turn pipeline (send). */
  private turnRunner: BrainTurnRunner;
  /** Read-only views: status, session lists, history, search, readiness. */
  private statusView: BrainStatusService;
  /** Sub-agent delegation: boot reconcile, drill-in reads/continuations, and the single delegated-turn
   *  dispatch. Owns every path that touches a `brain-ch-subagent-*` child. */
  private delegated: DelegatedSessionService;
  /** The destructive session lifecycle: turn interruption (Esc/Stop), the client-close stop, the idle
   *  reaper and conversation delete/purge — see SessionTeardownService. */
  private teardown: SessionTeardownService;
  /** Background-process ownership + the owner-scoped process panel — see SessionProcessService. */
  private processSvc: SessionProcessService;
  /** The mid-turn message backlog (list/remove/recall) — see SessionQueueService. */
  private queue: SessionQueueService;
  /** A plugin reload is owed but could not be applied yet: a plugin (e.g. the skills plugin's
   *  CreateSkill) asked for one from INSIDE a running turn — reloading there would dispose the very
   *  session executing the tool — or an attempt gave up waiting for work to drain. Either way the intent
   *  is coalesced onto this flag and drained once a turn settles (see drainDeferredPluginReload), so the
   *  runtime converges on the persisted plugin set without a daemon restart. */
  private pendingPluginReload = false;
  /** This process's selected platform adapters have completed their initial start. A registry rebuild
   *  before this point validates boot-restored plugins but must not connect an adapter early: the next
   *  restore would otherwise cycle it and destroy any channel session it accepted in between. */
  private pluginRuntimeStarted = false;
  /** A runner starts only its `subagent` adapter and no services; preserve that exact lifecycle shape when
   *  it reloads instead of either stranding the new adapter generation or starting every daemon gateway. */
  private pluginServicesStarted = false;
  private pluginPlatformFilter: readonly string[] | undefined;
  constructor(private d: BrainDeps) {
    // One identity per daemon boot, stamped onto every running sub-agent row. A LATER boot uses it to tell
    // a restart orphan (owner_boot_id != this) from its own live work, and to accept a delegated
    // completion only for the boot that owns the run. Generated here because BrainService is a per-daemon
    // singleton, so its construction coincides with the boot.
    d.store.setDelegationBootId(randomUUID());
    // Mid-turn messages are STEERED into the running turn via PI's native queue (session.steer); PI fans
    // its transient backlog as `queue_update`, mapped to the `queue` snapshot event in the spawner.
    this.factory = new BrainSessionFactory({ store: d.store, chatImagesDir: d.chatImagesDir, onTurnSettled: d.onTurnSettled, createSession: d.createSession, resourceLoaderFactory: d.resourceLoaderFactory });
    this.identity = new IdentityResolver({ platformOwner: d.platformOwner, resolvePlatformUser: d.resolvePlatformUser, users: d.users });
    this.titler = new ConversationTitler({ store: d.store, inference: d.inference ?? (() => null), logger: logger('conversation-titler') });
    // Built before the channel service so it can share the SAME curator instance — channel and
    // owner-chat memory then run through one implementation.
    if (d.memoryStore && d.memoryService) {
      this.curator = new MemoryCurator({
        store: d.memoryStore, service: d.memoryService,
        inference: d.inference ?? (() => null), categorizer: d.memoryCategorizer,
        ...(d.memoryCuratorMaxOps ? { maxOps: d.memoryCuratorMaxOps } : {}),
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
      get runtime() { return d.runtime; },
      get users() { return d.users; },
      get prompts() { return d.prompts; },
      get chatImagesDir() { return d.chatImagesDir; },
      get url() { return d.url; },
      get cwd() { return d.cwd; },
      get projectPath() { return d.projectPath; },
      get userSettings() { return d.userSettings; },
      get activeUserInstructions() { return d.activeUserInstructions; },
      get brand() { return d.brand; },
      get maxSteps() { return d.maxSteps; },
      get runtimeConfig() { return d.runtimeConfig; },
      get memoryStore() { return d.memoryStore; },
      get memoryService() { return d.memoryService; },
      get liveRecallBudget() { return d.liveRecallBudget; },
      get memoryCategoryStore() { return d.memoryCategoryStore; },
      get memoryCategorizer() { return d.memoryCategorizer; },
      get projects() { return d.projects; },
      plugins: () => this.resolvePlugins(),
      factory: this.factory,
      sessionTaps: (sessionId) => this.attachments.sessionTaps.get(sessionId) ?? [],
    });
    this.lifecycle = new ConversationLifecycle({
      store: d.store, sessions: this.sessions, attachments: this.attachments,
      elicitation: this.elicitation, goals: this.goals, cards: this.cards,
      spawn: (o) => this.spawner.spawn(o),
      get policy() { return d.policy; },
      get userSettings() { return d.userSettings; },
      get projectModelPreference() { return d.projectModelPreference; },
      get setProjectModelPreference() { return d.setProjectModelPreference; },
      selectionAllowed: (userId, sel) => this.permissionSvc.selectionAllowed(userId, sel),
    });
    this.turnRunner = new BrainTurnRunner({
      store: d.store, sessions: this.sessions,
      admitsNewWork: () => !this.draining && !this.reloadingPlugins,
      lifecycle: this.lifecycle, goals: this.goals, permissions: this.permissionSvc,
      elicitation: this.elicitation, cards: this.cards, identity: this.identity,
      titler: this.titler, curator: this.curator,
      get chatImagesDir() { return d.chatImagesDir; },
      get prompts() { return d.prompts; },
      get users() { return d.users; },
      get userSettings() { return d.userSettings; },
      get memoryService() { return d.memoryService; },
      get memoryCategoryStore() { return d.memoryCategoryStore; },
      get projects() { return d.projects; },
      plugins: () => this.resolvePlugins(),
      toolAuthorityFor: (userId) => toolAuthorityForUser(d, userId),
      get hookAudit() { return d.hookAudit; },
      get projectPath() { return d.projectPath; },
      sendDelegatedCustom: async (userId, sessionId, customType, content, resultId) => {
        await this.delegated.sendDelegated(userId, sessionId, content, { internalSystem: { customType, resultId } });
      },
      get usageOrigins() { return d.usageOrigins; },
      get recordActivity() { return d.recordActivity; },
      drainPluginReload: () => { this.drainDeferredPluginReload(); },
      notifyTurnComplete: (userId, sessionId, userInitiated, senderClientId) => {
        // A turn a person asked for just finished and the surface they typed on is not showing it — tell
        // their phone. The question is about the SENDER's device, not the conversation as a whole: the user
        // is wherever they wrote from, so a terminal left running on a desktop must not speak for a phone
        // that has since been locked. Attachment alone cannot answer it either, because a browser holds
        // its SSE stream open behind a locked screen; clients report whether they are on screen, and one
        // that never reports counts as watching, which is what keeps a terminal in active use quiet.
        // A turn with no identified sender falls back to "is anyone at all watching".
        // Enablement is implicit: no push subscription means the notifier sends nothing.
        const watching = senderClientId
          ? this.attachments.senderIsWatching(userId, senderClientId, sessionId)
          : this.attachments.watchingCount(sessionId) > 0;
        if (userInitiated && !watching && d.notifyTurnComplete) {
          // Only the turn that just settled, not the whole conversation: the answer is by definition in it,
          // and this runs on every notified turn. Reasoning blocks carry no `text`, so they drop out.
          d.notifyTurnComplete(userId, d.store.getSession(sessionId)?.title ?? '', lastAssistantTextIn(d.store.getLatestTurn(sessionId)));
        } else if (d.notifyTurnComplete) {
          // Both reasons for staying quiet look identical from outside — the user just does not get a
          // notification — and the two need opposite fixes. Not user-initiated means an internal goal or
          // nudge; watching means the surface that sent it is on screen.
          logger('brain').info(`no phone push for ${sessionId}: userInitiated=${userInitiated} watching=${watching} sender=${senderClientId ?? 'none'}`);
        }
      },
    });
    this.statusView = new BrainStatusService({
      store: d.store, sessions: this.sessions, attachments: this.attachments,
      elicitation: this.elicitation, cards: this.cards,
      lifecycle: this.lifecycle, permissions: this.permissionSvc,
      get config() { return d.config; },
      get runtime() { return d.runtime; },
      get createSession() { return d.createSession; },
      get cwd() { return d.cwd; },
      get policy() { return d.policy; },
    });
    this.channelService = new ChannelSessionService({
      registry: this.sessions, admitsNewWork: () => !this.draining && !this.reloadingPlugins,
      store: d.store, cards: this.cards, users: d.users,
      maxChannels: () => this.limits().channelSessionCap,
      spawn: (o) => this.spawner.spawn(o), // composition stays in the spawner — single source
      // Verified channel senders get memory too, keyed on their linked account and their own toggles.
      memoryService: d.memoryService, memoryCategoryStore: d.memoryCategoryStore, curator: this.curator, userSettings: d.userSettings,
      elicitation: this.elicitation, // one registry so Discord interactions resolve channel questions
      titler: this.titler, // name a brand-new channel conversation, same as owner chat
      permissions: d.permissions, // deny rules apply to channel turns too (asks follow unattendedAsks there)
      // Same plugin hook as owner chat: a plugin's per-turn context must not skip platform rooms.
      plugins: () => this.resolvePlugins(),
      get hookAudit() { return d.hookAudit; },
      completeSubagent: (parentSessionId, userId, completion) =>
        this.turnRunner.acceptSubagentCompletion(parentSessionId, userId, completion),
      completeWorkflow: (parentSessionId, userId, completion) =>
        this.turnRunner.acceptWorkflowCompletion(parentSessionId, userId, completion),
      cancelWorkflows: (sessionId) => this.teardown.cancelWorkflowsFor(sessionId),
      // The same drain the owner surface has always had, so a skill created from a room applies there too.
      drainPluginReload: () => { this.drainDeferredPluginReload(); },
      onDelegatedEdge: (parentSessionId, childSessionId, running) =>
        this.delegatedEdgeReporter?.(parentSessionId, childSessionId, running),
      // A delegated child running in the sub-agent runner has no live record here, so `/stop` can fence
      // the delegation but not interrupt the model call. This verb reaches the process that holds it.
      ...(d.subagentRunner ? { abortRemote: (channelId: string) => d.subagentRunner?.abort(channelId) } : {}),
    });
    this.subagents = new SubagentDispatch({
      runTurn: (request, text, onEvent) => this.runDelegatedTurn(request, text, onEvent),
      fenceRemote: (request, run) => this.channelService.sendRemote(request, run),
      ...(d.subagentRunner ? { runner: d.subagentRunner } : {}),
      runnerEnabled: () => d.runtimeConfig?.().subagentRunnerEnabled === true,
    });
    this.delegated = new DelegatedSessionService({
      store: d.store, sessions: this.sessions, channelService: this.channelService, identity: this.identity,
      users: d.users, policyForProjects: d.policyForProjects,
      // A daemon-side delegated send (an owner drill-in, a DelegateContinue, a durable result delivery)
      // rehydrates the child from SQLite HERE, so the runner must not still be holding a live record for
      // it. Asking first is what keeps one child session from being live in two processes at once.
      ...(d.subagentRunner ? { releaseRemote: (channelId: string) => d.subagentRunner?.release(channelId) ?? Promise.resolve({ busy: false }) } : {}),
      // A DelegateContinue targeting a child whose turn runs in the sub-agent runner steers THROUGH that
      // process — only the process holding the PI session can inject into its running turn.
      ...(d.subagentRunner ? { steerRemote: (channelId: string, text: string) => d.subagentRunner?.steer(channelId, text) ?? Promise.resolve({ outcome: 'idle' as const }) } : {}),
    });
    this.pluginServices = new PluginServiceRunner(() => this.resolvePlugins());
    this.platforms = new PlatformOrchestrator({
      plugins: () => this.resolvePlugins(),
      recordActivity: d.recordActivity,
      usageOrigins: d.usageOrigins,
      platformOwner: d.platformOwner,
      agents: d.agents,
      // A linked platform sender uses the same account policy and tool grant wherever they write.
      policyForUser: d.policy,
      toolAuthorityFor: (userId) => toolAuthorityForUser(d, userId),
      identity: this.identity,
      channels: this.channelService,
      dispatch: this.subagents,
      restart: () => this.restartHandler,
      // Owner-chat origin work only. Direct platform origins are deliberately intercepted by
      // PlatformOrchestrator and run through ChannelSessionService + the outbound adapter; routing a
      // `brain-ch-*` row through send() would create an owner-chat live session with owner capabilities.
      originSend: async (userId, sessionId, text, onEvent) => {
        // No session named → the account's own default conversation. A scheduled job somebody owns has
        // no originating conversation, but its result belongs to that person, not to a channel session
        // anchored on the instance admin. An account that has never chatted has no row yet, so this
        // degrades to the caller's own fallback exactly like a vanished origin does.
        const target = sessionId ?? defaultUserSessionId(userId);
        const row = this.d.store.getSession(target);
        // An account that has never chatted has no row for its own default conversation yet. That is not
        // somebody else's session — it is one that does not exist, and `send` creates it under this
        // account. Refusing here would push the turn onto the channel fallback, where the transcript ends
        // up in a session owned by the operator: the exact place this person's job must not report.
        // A NAMED session still has to exist, belong to the account and be an owner-chat conversation;
        // only the derived default may be created. Channel rows never cross this boundary.
        const mayCreate = sessionId === undefined && row === undefined;
        if (!mayCreate && !isOwnedUserSession(row, userId, target)) return null;
        await this.send({ userId, text, mode: 'build', session: target });
        onEvent?.({ type: 'session', sessionId: target });
        return lastAssistantText(this.d.store, target);
      },
      // /context picker (all three platform surfaces): resolve the platform sender to their linked Elowen
      // account, then reach the SAME BrainService methods the web endpoint uses — one implementation, not
      // two. An unlinked sender has no bindable sessions: listing returns null, binding rejects.
      listContextSessions: (platform, platformUserId, opts) => {
        const linked = d.resolvePlatformUser?.(platform, platformUserId);
        return linked ? this.listContextSessions(linked.id, opts) : null;
      },
      bindContext: async (platform, platformUserId, channelKey, sessionId) => {
        const linked = d.resolvePlatformUser?.(platform, platformUserId);
        if (!linked) throw new Error('unknown session'); // no linked account → none of their sessions exist here
        return this.bindChannelContext(linked.id, channelKey, sessionId);
      },
    });
    // Destructive-lifecycle unit. Every collaborator is a live instance built above; `terminalTeardown` is
    // read through a getter because it is attached to the facade only AFTER construction (attachTerminalTeardown).
    this.teardown = new SessionTeardownService({
      store: d.store, sessions: this.sessions, attachments: this.attachments,
      elicitation: this.elicitation, goals: this.goals, cards: this.cards,
      channelService: this.channelService, lifecycle: this.lifecycle, idleClock: this.idleClock,
      resolvePlugins: () => this.resolvePlugins(),
      terminalTeardown: () => this.terminalTeardown,
    });
    this.processSvc = new SessionProcessService({ store: d.store, attachments: this.attachments, identity: this.identity });
    this.queue = new SessionQueueService({ sessions: this.sessions, lifecycle: this.lifecycle });
  }

  /** Admin daemon-restart handler for a platform `/restart` slash. Late-bound: it's built after the brain
   *  (it needs the systemd units + marker path), so bootstrap sets it once ready. Undefined ⇒ unavailable. */
  restartHandler?: (byUserId: number) => Promise<void>;

  /** Run after the registry has ACTUALLY been rebuilt — never after a deferral. The marketplace hangs its
   *  deferred installs here: an install that arrives from chat can only ever be deferred (the turn it waits
   *  for is the one that asked for it), so this is the moment its rollback copy can finally be judged.
   *  Late-bound because the marketplace is constructed after the brain, like `restartHandler`. */
  afterPluginsApplied?: () => Promise<void>;

  /** Tear down the admin chat terminal bound to a conversation before it is deleted (BrainTerminalService.
   *  stopForSession). Late-bound: the terminal service is constructed AFTER the brain (it needs store+users),
   *  so bootstrap attaches this once ready — avoids a constructor cycle (mirrors SpawnService.attachBrainWorker).
   *  Undefined ⇒ no terminals wired; the janitor sweep still reaps an orphaned binding as a backstop. */
  private terminalTeardown?: (userId: number, sessionId: string) => Promise<void>;
  attachTerminalTeardown(fn: (userId: number, sessionId: string) => Promise<void>): void {
    this.terminalTeardown = fn;
  }

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.sessions.withLock(key, fn);
  }

  /** Work still in flight — see LiveSessionRegistry.busy. Read by the daemon's graceful shutdown so a
   *  restart waits for running turns and delegated children instead of cutting them off mid-sentence.
   *
   *  `undelivered` covers the gap the first version missed: a sub-agent that has FINISHED is not finished
   *  work. Its answer still has to be picked up by a parent turn, and in that window the child is already
   *  gone from the live registry — so turns and children can both read zero while a completed delegation
   *  has still never reached the agent that asked for it. Exiting there is exactly how a result got lost. */
  busy(): { turns: number; children: number; undelivered: number } {
    return { ...this.sessions.busy(), undelivered: this.d.store.countPendingDeliveries() };
  }

  /** Latched true by the graceful-shutdown handler on the first SIGTERM. From then on a NEW turn is
   *  refused (turnRunner.send / channelService.send) so {@link busy} can fall to zero and the drain can
   *  exit — otherwise fresh input arriving through the drain window keeps it busy for the full budget.
   *  One-way: a draining daemon is on its way out, never back to admitting. Delegation and result
   *  delivery take other seams, so they keep running and the drain still waits for them. */
  beginDrain(): void {
    this.draining = true;
  }

  /** One-shot boot sweep for restart-zombie goals — see GoalLoopService.reconcileGoalsOnBoot. */
  reconcileGoalsOnBoot(): void {
    this.goals.reconcileGoalsOnBoot();
  }

  /** The delegation twin of {@link reconcileGoalsOnBoot}: every durable sub-agent/workflow row the DB still
   *  marks `running` at boot is a zombie — see DelegatedSessionService.reconcileDelegationsOnBoot. */
  reconcileDelegationsOnBoot(): void {
    this.delegated.reconcileDelegationsOnBoot();
  }

  /** Boot phase 2: respawn the delegations reconcileDelegationsOnBoot claimed, once platforms are up — see
   *  DelegatedSessionService.runDelegationRecovery. Detached from boot so a multi-minute recovery turn
   *  never blocks startup, and deliberately AFTER startPlatforms so the respawned child turns can run. */
  async runDelegationRecovery(): Promise<void> {
    await this.delegated.runDelegationRecovery();
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
  async compact(userId: number, session?: string, customInstruction?: string): Promise<CompactResult> {
    const sessionId = session ? this.lifecycle.ownedUserSession(userId, session) : this.lifecycle.activeSessionId(userId);
    if (!this.sessions.get(sessionId)) throw new Error('brain not started');
    return this.serial(sessionId, async () => {
      const live = this.sessions.get(sessionId);
      if (!live) throw new Error('brain not started');
      live.interactedAt = Date.now(); // a manual compact is a deliberate touch — don't idle-roll it over
      // A real compaction fires PI's `compaction_end`, which the factory's session subscription mirrors
      // into the store and the spawner fans `compacted` to attached clients — persistence + notify ride the
      // event, not this call. A no-op (session too small) emits no result and leaves the store untouched.
      const result = await runCompaction(live.session, customInstruction);
      result.usage = withDescendantUsage(result.usage, this.d.store.descendantUsage(live.sessionId));
      return result;
    });
  }

  /** Clear a conversation's content (the /clear command): the stored history, transcript markers, card
   *  panel and live PI context are emptied while the conversation keeps its id, title, model and attached
   *  clients — see ConversationLifecycle.clearConversation. Targets the active conversation, or the
   *  caller's explicit `session` (a bound CLI). Throws (409 at the route) while work is in flight. */
  async clearSession(userId: number, session?: string): Promise<{ sessionId: string; model: string }> {
    return this.lifecycle.clearConversation(userId, session);
  }

  /** Stop the streaming turn (the Esc key in chat clients) — on the active conversation, or on the
   *  caller's explicit `session` (a bound CLI). The agent settles into agent_end → the idle event, so
   *  subscribed clients wind down on their own. */
  async abort(userId: number, session?: string): Promise<void> {
    return this.teardown.abort(userId, session);
  }

  /** Interrupt the current PI run and immediately promote the oldest native queued message into a fresh
   * owner turn. The parent-abort fence stays closed from queue snapshot through new-turn admission, so a
   * concurrent send cannot slip between abort and injection. Remaining messages are re-steered in their
   * original order with image/display/mode metadata intact. */
  async interruptQueued(
    userId: number,
    session?: string,
    client?: BoundClientRequest,
  ): Promise<{ interrupted: boolean; injected: boolean }> {
    const target = this.preflightSend(userId, session, client);
    const b = this.sessions.get(target);
    if (!b) throw new Error('brain not started');
    this.sessions.beginParentAbort(b.sessionId);
    try {
      // Snapshot BEFORE aborting. An empty queue means there is nothing to promote, so this is NOT an
      // interrupt: leave the running turn untouched and report it. The server is authoritative here (the
      // CLI Esc race #8) — a stale one-press must never destroy a live turn on an already-drained queue;
      // the client degrades to its normal two-press arming. `interrupted:true` ⇔ the turn was really aborted.
      const snapshot = this.queuedSnapshot(b);
      if (snapshot.length === 0) return { interrupted: false, injected: false };
      await this.teardown.abortLive(b);

      const requestFor = (message: QueuedMsg): TurnRequest => ({
        userId,
        // The clean model-facing text, never the durable copy: `persistText` carries the `[📎 …]` marker and
        // `message.text` the running-subagents block, both of which the fresh turn re-derives on its own.
        text: message.echo?.sourceText ?? message.text,
        images: message.images?.map(({ data, mimeType }) => ({ data, mimeType })),
        mode: message.echo?.mode ?? 'build',
        session: b.sessionId,
        display: message.echo?.displayText,
        client,
        interruptResume: true,
      });
      // Track how many queued messages were durably consumed (promoted or re-steered) so a mid-way failure
      // can restore exactly the un-consumed tail instead of silently dropping the user's backlog.
      let consumed = 0;
      try {
        const [first, ...remaining] = snapshot;
        const operation = this.startSend(requestFor(first!));
        void operation.completed.catch(async (error) => {
          try {
            const admittedSession = await operation.admitted;
            logger('brain-interrupt').error(`accepted interrupt turn failed for ${admittedSession}`, error);
            this.publishAcceptedSendFailure(admittedSession, error);
          } catch { /* pre-admission failure is rethrown below */ }
        });
        await operation.admitted;
        consumed = 1;
        for (const message of remaining) { await this.send(requestFor(message)); consumed += 1; }
        return { interrupted: true, injected: true };
      } catch (error) {
        // Promotion failed partway (the first turn never admitted, or a later re-steer was rejected). Put
        // the messages we never consumed back on the queue in their original order so the user does not lose
        // them, then surface the failure. Each restore is caught individually so one bad entry cannot block
        // the rest — the parent-abort fence is still held, so no concurrent send can interleave here.
        // Re-resolve the live session: a promoted image turn on a text-only model respawns the conversation
        // in place (maybeVisionHop disposes and re-creates the LiveBrain under the same id), so the `b` we
        // captured before the promotion can be a disposed shell whose queue and mirror nobody reads.
        const restoreTo = this.sessions.get(b.sessionId) ?? b;
        for (const message of snapshot.slice(consumed)) {
          try {
            await enqueueMirrored(restoreTo, 'steer', message.text, message.images, message.echo);
          } catch (restoreError) {
            logger('brain-interrupt').error(`failed to restore a queued message for ${b.sessionId}`, restoreError);
          }
        }
        throw error;
      }
    } finally {
      this.sessions.endParentAbort(b.sessionId);
    }
  }

  /** Snapshot PI's authoritative queue order while retaining Elowen's image/display metadata mirror. */
  private queuedSnapshot(live: LiveBrain): QueuedMsg[] {
    const copy = (items: readonly string[], mirror: readonly QueuedMsg[] | undefined): QueuedMsg[] =>
      items.map((text, index) => ({ ...(mirror?.[index] ?? { text }), text: mirror?.[index]?.text ?? text }));
    return [
      ...copy(live.session.getSteeringMessages(), live.queuedSteer),
      ...copy(live.session.getFollowUpMessages(), live.queuedFollowUp),
    ];
  }

  /** Whether `sessionId` is safe for `bindChannelContext` to re-key onto a new id right now — the
   *  review's smallest safe fix for the `/context` move (Tier 2 #13): refuse the bind rather than migrate
   *  every sidecar map that is keyed on the OLD id (attachments, live children, processRegistry, the goal
   *  loop). Fails closed like `sessionIsIdle` below, but deliberately does NOT take its "`!live` → idle"
   *  shortcut: a background delegate, a workflow node or a goal continuation can all still be keyed on
   *  this id with no LiveBrain currently spawned in memory, and re-keying it would orphan them exactly as
   *  it would if the session were live. */
  private isBindQuiescent(sessionId: string): boolean {
    if (this.sessions.get(sessionId)?.session.isStreaming) return false;
    // An attached client stream (web dock, CLI tap/subscribe) or a mid-boot start claim both read/write
    // through the OLD id; neither follows a bare `reassignSession`, so either would go dark or misfire.
    if (this.attachments.attachedCount(sessionId) !== 0 || this.attachments.hasPendingStartClaim(sessionId)) return false;
    if (this.sessions.hasActiveChildren(sessionId) || this.teardown.sparedChildSessionIds(sessionId).size > 0) return false;
    if (processRegistry.runningJobCountForSession(sessionId) > 0) return false;
    if (this.d.store.getGoal(sessionId)?.status === 'active') return false;
    return true;
  }

  /** A CLI is closing: stop its bound run and release the live PI session unless another interactive
   *  client is still on this conversation — see SessionTeardownService.stopSession. */
  async stopSession(userId: number, session?: string, clientId?: string, clientGeneration?: number, opts?: { detachOnly?: boolean }): Promise<{ stopped: boolean; disposed: boolean }> {
    return this.teardown.stopSession(userId, session, clientId, clientGeneration, opts);
  }

  /** Periodic sweep: dispose live PI sessions unwatched and idle for a full SESSION_IDLE_ROLLOVER_MS —
   *  see SessionTeardownService.reapIdleLiveSessions. */
  async reapIdleLiveSessions(now: number = Date.now()): Promise<string[]> {
    return this.teardown.reapIdleLiveSessions(now);
  }

  /** Settle a parked `AskUserQuestion` with the user's picks (from POST /brain/answer or a Discord
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

  /** Record that the client moved its working directory (the CLI's /cd), as a visible marker plus a
   *  one-shot notice telling the agent on its next turn.
   *
   *  The directory itself needs no plumbing: every turn already reports the client's cwd and it beats the
   *  session's stored one. What it does NOT do is tell the MODEL — that is composed once, when the session
   *  spawns, so without this the agent keeps describing the directory it started in until something
   *  respawns it. The marker closes exactly that gap, the same way a model or reasoning switch does.
   *
   *  Policy-checked, not merely recorded: an unreachable directory is the caller's mistake and the agent
   *  must not be told the work moved somewhere it cannot go. */
  noteWorkDir(userId: number, dir: string, session?: string): { workDir: string } {
    const b = session ? this.sessions.get(this.lifecycle.ownedUserSession(userId, session)) : this.lifecycle.activeLive(userId);
    if (!b) throw new Error('brain not started');
    const resolved = clientDir(b.policy, dir);
    if (!resolved) throw new Error('directory is not readable or not allowed');
    // Assigning is what makes the comparison mean "has it moved since we last said so". `workDir` is
    // otherwise written once at spawn and only carried across respawns, so without this the guard forever
    // compares against the launch directory: it would re-announce every /cd to a directory that is not the
    // launch one, and stay silent on a move BACK to it. It also keeps the per-turn fallback honest — a
    // goal continuation carries no client cwd and would otherwise resolve where the session started.
    if (resolved !== b.workDir) {
      recordSessionEvent(this.d.store, b.sessionId, b, 'cwd', resolved);
      b.workDir = resolved;
    }
    return { workDir: resolved };
  }

  /** Set the reasoning effort of the ACTIVE conversation live (the /think command) — PI applies it to
   *  the running session without a respawn, unlike a model switch. A level the current model doesn't
   *  support is clamped by PI. Returns the effective level.
   *
   *  This applies it to the LIVE session only. Persisting the choice as the account default is the
   *  /brain/think route's job, because that is where the caller's token scope is known — see the note
   *  there for why the two must not disagree. */
  async setThinkingLevel(userId: number, level: string, session?: string): Promise<{ thinkingLevel: string }> {
    const b = session ? this.sessions.get(this.lifecycle.ownedUserSession(userId, session)) : this.lifecycle.activeLive(userId);
    if (!b) throw new Error('brain not started');
    const sess = b.session as { setThinkingLevel?: (l: string) => void; thinkingLevel?: string; getAvailableThinkingLevels?: () => string[] };
    const model = b.session.model as Model<Api> | undefined;
    const canonical = model ? canonicalThinkingLevel(model, level) : level;
    const available = new Set(sess.getAvailableThinkingLevels?.() ?? CANONICAL_THINKING_LEVELS);
    if (!available.has(canonical)) throw new Error(`model does not support reasoning effort "${level}"`);
    const prevLevel = b.thinkingLevel;
    sess.setThinkingLevel?.(canonical);
    b.thinkingLevel = canonical;
    b.interactedAt = Date.now(); // a reasoning-effort change is a deliberate touch — don't idle-roll it over
    // The level above applied immediately; only the MARKER is debounced, so ctrl+r cycling through the
    // ladder lands one marker with the settled level instead of one per keypress.
    scheduleReasoningMarker(this.d.store, b, prevLevel, canonical);
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
  status(userId: number, session?: string): BrainStatusView {
    return this.statusView.status(userId, session);
  }

  /** What is filling the conversation's context window right now — see BrainStatusService.contextBreakdown. */
  contextBreakdown(userId: number, session?: string): BrainContextBreakdown | null {
    return this.statusView.contextBreakdown(userId, session);
  }

  /** The caller's pending mid-turn message backlog — see SessionQueueService.queueList. */
  queueList(userId: number, session?: string): { id: string; text: string }[] {
    return this.queue.queueList(userId, session);
  }

  /** Remove ONE pending mid-turn message by position — see SessionQueueService.queueRemove. */
  queueRemove(userId: number, id: string, session?: string): boolean {
    return this.queue.queueRemove(userId, id, session);
  }

  /** Pop the LAST pending mid-turn message and hand back its text — see SessionQueueService.queueRecall. */
  queueRecall(userId: number, session?: string): { text: string | null } {
    return this.queue.queueRecall(userId, session);
  }

  /** Flip the SESSION-scoped YOLO override (the CLI `/yolo` command) — see PermissionApprovalService.
   *  Throws when no conversation is live. */
  setYolo(userId: number, on?: boolean, session?: string): { yolo: boolean } {
    const b = session ? this.sessions.get(this.lifecycle.ownedUserSession(userId, session)) : this.lifecycle.activeLive(userId);
    if (!b) throw new Error('brain not started');
    return this.permissionSvc.setYolo(userId, b, on);
  }

  /** Delete one of the user's stored conversations (never a channel session, never someone else's) —
   *  see SessionTeardownService.deleteSession. */
  async deleteSession(userId: number, sessionId: string): Promise<void> {
    return this.teardown.deleteSession(userId, sessionId);
  }

  /** Branch one of the caller's OWN conversations into a new peer conversation seeded with a copy of its
   *  history (never a channel/task session, never someone else's — the shared isOwnedUserSession rule).
   *
   *  Purely a store operation, deliberately: the source's LIVE session is never consulted or disturbed, so
   *  forking a conversation mid-turn cannot perturb the turn that is running. The fork exists only in
   *  SQLite until someone opens it, and then spawns and rehydrates from the copied rows exactly like any
   *  other stored conversation. It keeps the source's title — that title was derived from the first user
   *  message, which the fork shares — and can be renamed like any other conversation. */
  forkSession(userId: number, sessionId: string): BrainForkedSession {
    const row = this.d.store.getSession(sessionId);
    if (!isOwnedUserSession(row, userId, sessionId)) throw new Error('unknown session');
    const fork = this.d.store.forkSession(sessionId, freshUserSessionId(userId));
    return { id: fork.id, title: fork.title, forkedFrom: sessionId };
  }

  renameSession(userId: number, sessionId: string, title: string): { id: string; title: string } {
    const row = this.d.store.getSession(sessionId);
    const clean = collapseWhitespace(title).slice(0, 120);
    if (!isOwnedUserSession(row, userId, sessionId)) throw new Error('unknown session');
    if (!clean) throw new Error('title cannot be empty');
    const changed = row.title !== clean;
    this.d.store.renameSession(sessionId, clean);
    // A visible marker + one-shot notice when the conversation is live; when it isn't (renamed from the
    // picker), the marker is simply persisted for the next transcript load.
    if (changed) recordSessionEvent(this.d.store, sessionId, this.sessions.get(sessionId), 'rename', clean);
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

  /** The user's conversations with live/active/attached flags — see BrainStatusService.listSessions.
   *  Pagination is opt-in: no `opts` → the historical bare array; with `opts` → a paged window. */
  listSessions(userId: number): SessionListItem[];
  listSessions(userId: number, opts: SessionPageOpts): SessionPage<SessionListItem>;
  listSessions(userId: number, opts?: SessionPageOpts): SessionListItem[] | SessionPage<SessionListItem> {
    return opts ? this.statusView.listSessions(userId, opts) : this.statusView.listSessions(userId);
  }

  /** The caller's conversations eligible to bind into a channel (the /context picker) — the bare default
   *  is excluded. Always paginated — see BrainStatusService.listContextSessions. */
  listContextSessions(userId: number, opts?: SessionPageOpts): SessionPage<SessionListItem> {
    return this.statusView.listContextSessions(userId, opts);
  }

  /** Bind (MOVE, not fork) one of the caller's own conversations INTO a platform channel slot so the
   *  channel's next turn continues in that conversation's history. IRREVERSIBLE by design: the chosen
   *  session is re-keyed onto the deterministic `brain-ch-<channel>` id, and whatever occupied the slot
   *  is archived under a fresh id (nothing is lost, exactly like idle rollover). Guards: only the caller's
   *  OWN sessions are bindable (owner-scope); never the bare default `brain-<uid>` (re-keying it would
   *  strip the user's default id) and never a channel/task session; a session can hold only one slot, so a
   *  second bind of the same id finds nothing and throws. Serialized on the channel session lock so it
   *  cannot race that channel's turn/compact/rollover. Returns the bound conversation's title for the
   *  adapter's confirmation message. */
  async bindChannelContext(callerUserId: number, channelKey: string, chosenSessionId: string): Promise<{ title: string }> {
    // Guard (b), id-only so it needs no store read: the bare default must never be re-keyed, and only a
    // real personal conversation (not a channel/task shell) may move into a shared channel.
    if (chosenSessionId === defaultUserSessionId(callerUserId) || isNonUserSession(chosenSessionId)) {
      throw new Error('this conversation cannot be bound to a channel');
    }
    const channelSession = channelSessionId(channelKey);
    // The channel session lock (same key the channel turn/compact/rollover take) serializes the whole move.
    return this.serial(channelSession, async () => {
      // Guards (a) + (c), resolved INSIDE the lock: only the caller's own session is bindable, and a second
      // bind of an already-moved id finds nothing here (the id ceased to exist on the first bind).
      const row = this.d.store.getSession(chosenSessionId);
      if (!row || row.user_id !== callerUserId) throw new Error('unknown session');
      // Smallest safe fix for the /context move (Tier 2 #13): durable bindings move with reassignSession
      // below, but the in-memory maps (attachments, live children, processes, the goal loop) do not, so a
      // session with real work still keyed on its OLD id would be orphaned by the move — refuse it
      // outright rather than migrate every one of those maps (judged needlessly risky).
      if (!this.isBindQuiescent(chosenSessionId)) {
        throw new Error('this conversation has work in progress and cannot be moved into a channel right now');
      }
      // A bound `elowen chat` terminal was launched with `--session <chosenSessionId>`; the re-key below
      // moves that id out from under it, so its tmux would resume a gone id and the next sweep would reap
      // it as 'conversationGone' — killing the live pane and revoking its token. Tear it down cleanly
      // first (mirrors deleteSession), a no-op when the conversation has no bound terminal.
      void this.terminalTeardown?.(callerUserId, chosenSessionId).catch((e) => logger('brain').error(`terminal teardown failed for ${chosenSessionId}`, e));
      // Live-session safety: a conversation open in web/CLI must not have its id changed underneath the
      // live PI object — dispose it and clear the active pointer first (mirrors deleteSession).
      if (this.sessions.get(chosenSessionId)) this.sessions.dispose(chosenSessionId);
      if (this.sessions.activeIdFor(callerUserId) === chosenSessionId) this.sessions.clearActive(callerUserId);
      // Clear the chosen session's in-memory sidecar state keyed on its OLD id before the re-key: the durable
      // rows move with reassignSession, but a goal-continuation timer, a parked question, or the cards cache
      // would otherwise dangle on an id that ceases to exist. Background processes/subagents are deliberately
      // NOT torn down — this is a move that keeps the work, not a delete.
      this.goals.cancelGoalContinuation(chosenSessionId);
      this.elicitation.cancelForSession(chosenSessionId, 'moved to channel');
      this.cards.clearSession(chosenSessionId);
      // Mirror the channel rollover (channels.ts): drop the live PI on the slot, ARCHIVE whatever occupies
      // `brain-ch-<key>` under a fresh id (a no-op touching 0 rows if the channel never spawned), then MOVE
      // the chosen session into the now-free deterministic channel slot in one transaction.
      this.sessions.channelDispose(channelKey);
      this.d.store.reassignSession(channelSession, archivedChannelSessionId(channelKey));
      this.d.store.reassignSession(chosenSessionId, channelSession);
      return { title: this.d.store.getSession(channelSession)?.title ?? '' };
    });
  }

  /** Fulltext search across the user's stored conversations — see BrainStatusService.searchMessages. */
  searchMessages(userId: number, query: string): BrainSearchHit[] {
    return this.statusView.searchMessages(userId, query);
  }

  /** Who is mid-turn RIGHT NOW, for the team feed's presence line.
   *
   *  Derived from the live session registry rather than from a separate presence table with a TTL: this
   *  IS the daemon's in-memory truth about running work, so it cannot drift, and a crash or restart
   *  leaves nobody stuck as "working" because the map is simply gone. History is never consulted —
   *  liveness that is inferred from the last event is a guess, and a wrong one after every restart.
   *
   *  Note this deliberately does NOT report a "typing" state: Discord, Teams, Telegram and WhatsApp
   *  never tell the daemon that someone is composing. A turn running is the only thing actually known. */
  presence(): { userId: number | null }[] {
    // Channel sessions live in their own registry, so iterating only liveEntries() would record a
    // Discord or Teams turn into the feed while the presence line right above it showed nobody.
    // `hasActiveChildren` matches the chat surface's own definition (statusService): a turn that has
    // handed its work to a sub-agent is still that person working.
    const entries = [...this.sessions.liveEntries(), ...this.sessions.channelEntries()];
    return entries
      .filter(([, live]) => live.session.isStreaming || this.sessions.hasActiveChildren(live.sessionId))
      .map(([, live]) => ({ userId: this.d.store.getSession(live.sessionId)?.user_id ?? null }));
  }


  /** ADMIN session-management view (the sessions/ panel) — see BrainStatusService.listManagedSessions. */
  listManagedSessions(userId: number): ManagedSessionView[] {
    return this.statusView.listManagedSessions(userId);
  }

  /** Admin-only request diagnostics. Authorization lives at the HTTP boundary; these methods intentionally
   *  span every managed user/channel/task session instead of applying caller ownership. */
  debugSessions(filters?: ProviderRequestDebugSessionFilters): BrainDebugSessionPage {
    return this.d.store.providerRequests.debugSessions(filters);
  }

  debugSession(sessionId: string): BrainDebugSessionItem | undefined {
    return this.d.store.providerRequests.debugSession(sessionId);
  }

  debugRequests(sessionId: string, filters?: ProviderRequestDebugRequestFilters): BrainDebugPage<BrainDebugRequestItem> | undefined {
    return this.d.store.providerRequests.debugRequests(sessionId, filters);
  }

  debugRequest(sessionId: string, requestId: string): BrainDebugRequestDetail | undefined {
    return this.d.store.providerRequests.debugRequest(sessionId, requestId);
  }

  debugRequestSegments(sessionId: string, requestId: string, opts?: { cursor?: string; limit?: number; maxBytes?: number }): BrainDebugPayloadPage | undefined {
    return this.d.store.providerRequests.debugSegmentPayloads(sessionId, requestId, opts);
  }

  debugRequestSegment(sessionId: string, requestId: string, index: number, maxBytes?: number): BrainDebugSegmentPayload | undefined {
    return this.d.store.providerRequests.debugSegmentPayload(sessionId, requestId, index, maxBytes);
  }

  debugRawRequest(sessionId: string, requestId: string, maxBytes?: number): BrainDebugRawPayload | undefined {
    return this.d.store.providerRequests.debugRawPayload(sessionId, requestId, maxBytes);
  }

  debugLegacyTranscript(sessionId: string, opts?: { cursor?: string; limit?: number; maxBytes?: number }): BrainDebugLegacyTranscriptPage | undefined {
    return this.d.store.debugLegacyTranscript(sessionId, opts);
  }

  /** Delete ANY of the owner's brain sessions by id (admin panel) — see
   *  SessionTeardownService.deleteManagedSession. */
  deleteManagedSession(userId: number, id: string, scope: 'own' | 'any' = 'own'): number {
    return this.teardown.deleteManagedSession(userId, id, scope);
  }

  /** Delete ALL of the owner's brain sessions (the panel's "delete everything" — the client confirms) —
   *  see SessionTeardownService.deleteAllManagedSessions. */
  deleteAllManagedSessions(userId: number, scope: 'own' | 'any' = 'own'): number {
    return this.teardown.deleteAllManagedSessions(userId, scope);
  }

  /** Retention janitor: delete this user's own idle top-level conversations older than `days` — see
   *  SessionTeardownService.purgeStaleSessionsForUser. */
  async purgeStaleSessionsForUser(userId: number, days: number): Promise<number> {
    return this.teardown.purgeStaleSessionsForUser(userId, days);
  }

  /** Start (or resume) a conversation — see ConversationLifecycle.start. */
  async start(userId: number, opts?: { provider?: string; model?: string; session?: string; fresh?: boolean; cwd?: string; clientId?: string; clientGeneration?: number }): Promise<{ sessionId: string }> {
    const started = await this.lifecycle.start(userId, opts);
    // Drain only — never sweep. Opening a conversation says nothing about whether its still-'running'
    // delegation rows are orphans (see reconcileDelegationsOnBoot); the inbox may hold a background child's
    // result, or a restart orphan's synthetic one that boot enqueued but deliberately left undelivered.
    void this.turnRunner.drainPendingSubagentResults(userId, started.sessionId);
    return started;
  }

  /** Follow the user's ACTIVE conversation live — see ConversationLifecycle.subscribe. */
  subscribe(userId: number, listener: (e: BrainEvent) => void, clientId?: string, clientGeneration?: number): () => void {
    return this.lifecycle.subscribe(userId, listener, clientId, clientGeneration);
  }

  /** Follow one of the CALLER'S OWN sessions live, by explicit id — see ConversationLifecycle.tapSession. */
  tapSession(userId: number, sessionId: string, listener: (e: BrainEvent) => void, clientId?: string, clientGeneration?: number): () => void {
    return this.lifecycle.tapSession(userId, sessionId, listener, clientId, clientGeneration);
  }

  /** Install a fixed-session tap and capture its durable+live snapshot atomically. A delegated child may
   *  live in the forked runner rather than this daemon; in that case the same operation is forwarded to
   *  the process that owns its LiveBrain and replay journal. The route buffers listener events while this
   *  promise settles, so an event racing the IPC snapshot still belongs exactly once. */
  async tapSessionSnapshot(
    userId: number,
    sessionId: string,
    listener: (e: BrainEvent) => void,
    clientId?: string,
    clientGeneration?: number,
    history?: MessagePageOpts,
    opts: { anyOwner?: boolean } = {},
  ): Promise<{ off: () => void; snapshot: BrainStreamSnapshot }> {
    // ADMIN OVERSIGHT: reading a conversation belonging to somebody else (the cross-account register).
    // It returns the durable history and NOTHING ELSE -- no live tap. A tap would call attachments
    // .attach(), which is a WRITE to the owner's routing state: it counts as an attachment and can
    // re-key which session that person's CLI resumes. Reading someone's history must not move their
    // client around. The snapshot is taken AS THE OWNER, the same way a foreign teardown runs as the
    // session's real owner, so no ownership check is bypassed anywhere -- it is answered truthfully.
    const foreign = opts.anyOwner ? this.d.store.getSession(sessionId) : undefined;
    if (foreign && foreign.user_id !== userId) {
      return { off: () => {}, snapshot: this.statusView.streamSnapshot(foreign.user_id, sessionId, history) };
    }
    // Resolve and authorize in the daemon before crossing IPC. The runner repeats ownership validation;
    // userId and sessionId in the wire frame are routing facts, never an authority minted by the child.
    const targetSessionId = this.lifecycle.resolveStreamSession(userId, sessionId, clientId, clientGeneration);
    if (isSubagentSession(targetSessionId)) {
      const remote = await this.d.subagentRunner?.tapSessionSnapshot?.(userId, targetSessionId, listener, history);
      if (remote) return remote;
    }
    const off = this.lifecycle.tapSession(userId, targetSessionId, listener, clientId, clientGeneration);
    try { return { off, snapshot: this.statusView.streamSnapshot(userId, targetSessionId, history) }; }
    catch (error) { off(); throw error; }
  }

  /** Synchronous route preflight for `/brain/subagent/send`: a legacy child with no immutable scope
   *  must return 409 now, not be silently swallowed by the route's detached promise. */
  preflightSubagentSend(userId: number, sessionId: string): void {
    if (this.draining || this.reloadingPlugins) throw new Error('the daemon is temporarily not admitting new work');
    this.delegated.preflightSubagentSend(userId, sessionId);
  }

  /** The owner talking INTO a delegated sub-agent's session — see DelegatedSessionService.sendToSubagent. */
  async sendToSubagent(userId: number, sessionId: string, text: string): Promise<void> {
    if (this.draining || this.reloadingPlugins) throw new Error('the daemon is temporarily not admitting new work');
    return this.delegated.sendToSubagent(userId, sessionId, text);
  }

  /** A delegating turn reading the final stored reply of one of its own sub-agents — see
   *  DelegatedSessionService.readSubagent. */
  readSubagent(parentSessionId: string, childSessionId: string): string {
    return this.delegated.readSubagent(parentSessionId, childSessionId);
  }

  /** Stop a runaway or no-longer-needed DIRECT sub-agent — see DelegatedSessionService.stopSubagent. */
  async stopSubagent(parentSessionId: string, childSessionId: string): Promise<{ stopped: boolean }> {
    return this.delegated.stopSubagent(parentSessionId, childSessionId);
  }

  /** A delegating TURN continuing one of its own sub-agents — see DelegatedSessionService.continueSubagent.
   *  `onEvent` receives the child's live progress narrowed to the plugin contract shape
   *  ({@link SubagentProgressEvent}); the full BrainEvent stream never crosses this boundary. */
  async continueSubagent(
    parentSessionId: string,
    childSessionId: string,
    text: string,
    access: Parameters<DelegatedSessionService['continueSubagent']>[3],
    onEvent?: (e: SubagentProgressEvent) => void,
    model?: string,
    promote?: boolean,
  ): Promise<DelegatedContinueResult> {
    return this.delegated.continueSubagent(parentSessionId, childSessionId, text, access, onEvent, model, promote);
  }

  /** Run one user turn — see BrainTurnRunner.send. `display` is the client's clean rendering of the
   *  message (before @mention/prompt expansion) that the authoritative `user` echo shows; absent → the
   *  model-facing text is echoed. */
  /** Whether `userId` operates this instance — the operator or an admin account (see
   *  IdentityResolver.isOwner). Exposed so operator-only API surfaces — e.g. the background-process routes,
   *  which read/kill children of the terminal tools — gate on exactly the same notion the tools do. */
  isOwner(userId: number | undefined): boolean {
    return this.identity.isOwner(userId);
  }

  /** Push a background-process snapshot to the OWNER's live client streams — see
   *  SessionProcessService.broadcastProcesses. */
  broadcastProcesses(sessionId: string, processes: ProcessInfo[]): void {
    this.processSvc.broadcastProcesses(sessionId, processes);
  }

  /** The user's background processes — sessionless spans their whole tree, session-scoped is one
   *  conversation. See SessionProcessService.processes. */
  processes(userId: number, sessionId?: string): ProcessInfo[] {
    return this.processSvc.processes(userId, sessionId);
  }

  processOutput(userId: number, processId: string, sessionId?: string): string | null {
    return this.processSvc.processOutput(userId, processId, sessionId);
  }

  killProcess(userId: number, processId: string, sessionId?: string): boolean {
    return this.processSvc.killProcess(userId, processId, sessionId);
  }

  async send(request: TurnRequest): Promise<void> {
    return this.turnRunner.send(request);
  }

  /** Convert every authenticated foreground delegate currently blocking this parent into a detached
   * background job. The plugin owns child state; core owns session authorization and result delivery. */
  async detachForegroundSubagents(
    userId: number,
    session?: string,
    client?: BoundClientRequest,
  ): Promise<{ detached: number }> {
    const target = this.preflightSend(userId, session, client);
    const registry = await this.d.plugins?.get();
    const control = registry?.control('subagent');
    if (!control) return { detached: 0 };
    return control.detachForeground({ sessionId: target, principal: `elowen:${userId}` });
  }

  /** Record whether one client's window is on screen, so a finished turn knows whether anyone is actually
   *  reading it before it notifies the user's phone. Purely presence: it does not touch attachment, so a
   *  hidden tab keeps streaming and every lifecycle rule sees the conversation as held. */
  /** Attachment files of messages still sitting in a live queue. Their durable row is only written when
   *  PI delivers them, so until then nothing in the database refers to the files — and the sweep's grace
   *  period is measured from the write, which a turn running longer than an hour outlives. Without this
   *  the sweep would reclaim an attachment that is still on its way in. */
  pendingChatImageFiles(): string[] {
    const files: string[] = [];
    for (const [, live] of this.sessions.liveEntries()) {
      for (const queue of [live.queuedSteer, live.queuedFollowUp, live.deliveringUserEchoes]) {
        for (const item of queue ?? []) {
          for (const image of item.echo?.images ?? []) files.push(image.file);
        }
      }
    }
    return files;
  }

  setClientVisibility(userId: number, clientId: string, hidden: boolean): { applied: boolean } {
    return { applied: this.attachments.setClientVisibility(userId, clientId, hidden) };
  }

  /** Convert every running foreground `Bash` command in this conversation into a detached background job.
   * Mirror of detachForegroundSubagents against the terminal plugin's control — the plugin keeps the
   * process running and its eventual exit nudges this same conversation, exactly like Bash(background). */
  async detachForegroundCommands(
    userId: number,
    session?: string,
    client?: BoundClientRequest,
  ): Promise<{ detached: number }> {
    const target = this.preflightSend(userId, session, client);
    const registry = await this.d.plugins?.get();
    const control = registry?.control('terminal');
    if (!control) return { detached: 0 };
    return control.detachForeground({ sessionId: target, principal: `elowen:${userId}` });
  }

  /** Hard-kill every running foreground `Bash` command in this conversation — the stop ESCALATION (a
   * further Esc / repeat Ctrl+C after the graceful interrupt). PI's agent loop only re-checks its abort
   * signal between tool calls, so a long command otherwise pins the aborted turn until it exits on its
   * own; the terminal plugin SIGKILLs the process group and the settled Bash tool resolves as `[killed]`,
   * unwinding the turn. Structural mirror of detachForegroundCommands; never invoked by the daemon on its
   * own — the escalation decision stays with the client, so one client's innocent stop can never SIGKILL
   * a command another client's turn is running. */
  async killForegroundCommands(
    userId: number,
    session?: string,
    client?: BoundClientRequest,
  ): Promise<{ killed: number }> {
    const target = this.preflightSend(userId, session, client);
    const registry = await this.d.plugins?.get();
    const control = registry?.control('terminal');
    if (!control) return { killed: 0 };
    return control.killForeground({ sessionId: target, principal: `elowen:${userId}` });
  }

  /** Convert every foreground `WorkflowStart` currently blocking this parent into a detached background
   * workflow. Same shape as detachForegroundSubagents/Commands — the engine keeps running the DAG and
   * delivers its summary back into this conversation. Detach rides the workflow control (which already
   * owns `cancelForSession` — see api.ts KnownControls). */
  async detachForegroundWorkflows(
    userId: number,
    session?: string,
    client?: BoundClientRequest,
  ): Promise<{ detached: number }> {
    const target = this.preflightSend(userId, session, client);
    const registry = await this.d.plugins?.get();
    const control = registry?.control('workflow');
    if (!control) return { detached: 0 };
    return control.detachForeground({ sessionId: target, principal: `elowen:${userId}` });
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
  async restart(userId: number, opts: { reapplyModelPreference?: boolean } = {}): Promise<void> {
    return this.lifecycle.restart(userId, opts);
  }

  /** A user saved their auto-compact settings: re-apply the threshold to every conversation of theirs that
   *  is ALREADY live — their own chats and the channel sessions they own. Without this the new percentage
   *  only reached a session on its next respawn (model switch, rollover, daemon restart), so the setting
   *  looked broken: it was saved, and nothing happened to the conversation the user was sitting in.
   *
   *  No respawn happens here — PI reads its compaction settings at each check, so replacing the reserve in
   *  place is enough. Channels keep proactive compaction ALWAYS on (long-lived and unattended); only the
   *  threshold follows the owner, exactly as at spawn. */
  applyAutoCompactSettings(userId: number): void {
    const settings = this.d.userSettings?.(userId);
    const globalPct = settings?.autoCompactAt ?? DEFAULT_AUTO_COMPACT_PCT;
    // The same per-model resolution the spawner does, against the model this session actually runs on.
    const pctFor = (live: LiveBrain): number => (live.providerId
      ? resolveAutoCompactPct(settings?.autoCompactAtByModel, live.providerId, live.model, globalPct)
      : globalPct);
    for (const [sessionId, live] of this.sessions.liveEntries()) {
      if (this.d.store.getSession(sessionId)?.user_id !== userId) continue;
      live.applyCompaction(!!settings?.autoCompact, pctFor(live));
    }
    for (const [, live] of this.sessions.channelEntries()) {
      if (this.d.store.getSession(live.sessionId)?.user_id !== userId) continue;
      live.applyCompaction(true, pctFor(live));
    }
  }

  /** A user changed their global agent instructions: respawn so the new system-prompt chunk lands in every
   *  surface. The owner chat restarts and every channel session THIS USER OWNS is reset; other users stay
   *  untouched. History rehydrates from SQLite on respawn. Rare operation; serialized on its own key so it
   *  never interleaves a reload. */
  async applyUserInstructionsChange(userId: number): Promise<void> {
    await this.serial(`user-instructions-${userId}`, async () => {
      await this.restart(userId);
      await this.channelService.resetChannels('user instructions changed', (ownerUserId) => ownerUserId === userId);
    });
  }

  /** The instance BRAND changed (theme switched / agent renamed): the old identity sits at the very top
   *  of every live system prompt, so a session kept alive would keep speaking as the old name while the
   *  UI already shows the new one. Instance-wide variant of applyUserInstructionsChange — the brand is
   *  global, so every active owner session restarts and every channel session resets. History rehydrates
   *  from SQLite; the full prompt-prefix change means a complete prompt-cache re-warm, which is why the
   *  Settings UI warns before switching. Serialized on the SAME key as reloadPlugins — both loops restart
   *  the same sessions, and a brand sweep slipping between a reload's registry swap and its restart loop
   *  would respawn sessions against a half-replaced registry only for the reload to dispose them again. */
  async applyBrandChange(): Promise<void> {
    await this.serial('plugins-reload', async () => {
      for (const userId of this.sessions.activeUserIds()) await this.restart(userId);
      await this.channelService.resetChannels('brand changed');
    });
  }

  /** Work that must finish before this process can replace its plugin registry. Runner IPC calls this because
   *  daemon-side counters cannot see core turns, child edges or plugin closures owned by the forked brain. */
  async reloadOwnedWorkCount(): Promise<number> {
    const busy = this.busy();
    const registry = await this.d.plugins?.get();
    return busy.turns
      + busy.children
      + this.turnRunner.resultDeliveryWorkCount()
      + (registry?.control('subagent')?.activeCount() ?? 0)
      + (registry?.control('workflow')?.activeCount() ?? 0);
  }

  /** Wait until replacing the current plugin registry cannot cut through work owned by its closures. The
   *  core busy counters cover active turns/children; plugin controls cover delegates waiting between child
   *  turns and workflows between nodes — gaps where the live registry legitimately reads idle. */
  /** Wait for every kind of in-flight work to reach zero. Resolves true when the caller may swap the
   *  registry, false when the budget ran out — never throws, because the caller has to decide what an
   *  unreached quiet point means (defer, in practice) and an exception here read as "the reload broke". */
  private async waitForPluginReloadQuiescence(registry: PluginRegistry | undefined): Promise<boolean> {
    let announced = false;
    const deadline = Date.now() + PLUGIN_RELOAD_DRAIN_MS;
    while (true) {
      const runnerWork = await this.d.subagentRunner?.activeCount?.() ?? 0;
      // Read the daemon snapshot AFTER the asynchronous runner query. A runner completion can mirror a new
      // child edge while the IPC response is in flight; using a snapshot from before the query could reset
      // that runner even though the daemon had already learned about its newly active child.
      const busy = this.busy();
      const delegates = registry?.control('subagent')?.activeCount() ?? 0;
      const workflows = registry?.control('workflow')?.activeCount() ?? 0;
      // Pending durable result delivery belongs to the core, not to the old plugin closure. Waiting for it
      // would deadlock after its retry budget is exhausted: only a new user turn retries it, and admission is
      // intentionally closed here. It survives the registry swap and is delivered by the normal core path.
      if (busy.turns === 0 && busy.children === 0 && delegates === 0 && workflows === 0 && runnerWork === 0) {
        if (announced) logger('brain').info('plugin reload drain complete');
        return true;
      }
      const detail = `${busy.turns} turn(s), ${busy.children} child turn(s), ${delegates} delegation(s), ${workflows} workflow(s), ${runnerWork} runner task(s)`;
      if (!announced) {
        announced = true;
        logger('brain').info(`plugin reload waiting for work — ${detail}`);
      }
      if (Date.now() >= deadline) {
        logger('brain').info(`plugin reload gave up waiting for work without interrupting it — ${detail}`);
        return false;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, PLUGIN_RELOAD_POLL_MS));
    }
  }

  /** Invalidate the shared plugin registry and restart every live session — called when the admin flips
   *  a plugin on/off so the change applies without a daemon restart. New top-level work is paused first;
   *  existing turns, delegates, workflows and result delivery drain to completion before any closure or
   *  runner is replaced. Queued reload callers keep admission closed across the whole serialized batch.
   *
   *  Resolves `true` when the swap happened and `false` when the wait for running work ran out — the
   *  change is NOT lost then: the deferred flag is re-armed and the next settled turn applies it. It
   *  matters that this is a return value rather than a throw, because the config write has ALREADY
   *  landed by the time a route calls this; a throw made the caller report failure for a change that
   *  was on disk, leaving the runtime and the config silently disagreeing until a daemon restart. */
  async reloadPlugins(): Promise<boolean> {
    this.pluginReloadWaiters += 1;
    this.reloadingPlugins = true;
    try {
      // A parked question cannot finish without user input and may hold a turn for hours. Cancel it before
      // waiting; the turn unwinds normally and the quiescence loop observes its lock reach zero. The wait is
      // deliberately OUTSIDE the plugins-reload lock because busy().turns counts every held serial key.
      this.elicitation.cancelAll('plugins reloaded');
      const drainRegistry = await this.d.plugins?.get();
      if (!await this.waitForPluginReloadQuiescence(drainRegistry)) {
        // Work outlasted the budget. Re-arm instead of aborting for good, and reopen admission on the way
        // out (the finally below) so a busy instance is not left refusing turns over a pending toggle.
        this.pendingPluginReload = true;
        logger('brain').info('plugin reload deferred — work still running; it will apply when a turn settles');
        return false;
      }
      // Serialized: two rapid plugin toggles must not interleave stopAll()/startAll() and leave duplicate
      // connected adapters. The waiter counter above prevents a fresh turn slipping between queued reloads.
      await this.serial('plugins-reload', async () => {
        // Resolve the current registry only after taking the swap lock: an earlier queued reload may have
        // replaced the instance we drained, while admission stayed closed and kept the new one quiescent.
        const before = await this.d.plugins?.get();
        // Defensive hooks now normally see no work. They remain fail-safe for a plugin whose liveness signal
        // regresses, so an unreachable old closure is terminalized rather than orphaned.
        if (before) await new PluginHookBus({ hooks: before.hooks }).emit('plugin.reload.before', {});
        this.d.plugins?.invalidate();
        for (const userId of this.sessions.activeUserIds()) await this.restart(userId);
        const activeIds = this.sessions.activeIds();
        for (const [id] of this.sessions.liveEntries()) {
          if (!activeIds.includes(id)) this.sessions.dispose(id);
        }
        await this.channelService.resetChannels('plugins reloaded');
        // The old runners are idle now, but still hold the old tool registry; reset so the next delegation
        // forks against the new build/config without interrupting any work.
        this.d.subagentRunner?.reset('plugins reloaded');
        // Old plugin services hold pre-swap closures — stop them before the registry swap takes effect
        // for the adapters, and bring the NEW registry's services up only after its reconciles ran
        // (reconciles are idempotent by contract; a reload replays them like a boot). The old
        // generation's bus subscriptions detach with them, so a stale closure never double-handles
        // events beside its replacement.
        before?.disposeEventSubscriptions();
        if (this.pluginRuntimeStarted) {
          if (this.pluginServicesStarted) await this.pluginServices.stopAll();
          this.platforms.stopAll();
          if (this.pluginServicesStarted) await this.pluginServices.runBootReconciles();
          await this.platforms.startAll(undefined, this.pluginPlatformFilter);
          if (this.pluginServicesStarted) await this.pluginServices.startAll();
        }
        // A pre-runtime reload still has to force the lazy provider to rebuild now. install() treats this
        // await as its apply check and keeps the rollback folder until it succeeds; only adapter/service
        // startup is deferred to the one initial start after boot marketplace reconciliation settles.
        const after = await this.d.plugins?.get();
        if (after) await new PluginHookBus({ hooks: after.hooks }).emit('plugin.reload.after', {});
      });
      // The offered set changed only NOW. Announced after the swap so a browser that was told "saved,
      // applies when the work finishes" learns the moment it did, rather than showing the old worlds
      // until someone reloads the page.
      this.d.onPluginsReloaded?.();
      // Outside the swap lock on purpose: settling a deferred install may itself have to roll back and
      // reload, which takes that same lock. Its failure is its own to report and must not turn a reload
      // that DID happen into a failed one.
      if (this.afterPluginsApplied) {
        await this.afterPluginsApplied().catch((e) => logger('brain').error(`post-apply plugin hook failed: ${e instanceof Error ? e.message : String(e)}`));
      }
      return true;
    } finally {
      this.pluginReloadWaiters -= 1;
      if (this.pluginReloadWaiters === 0) this.reloadingPlugins = false;
    }
  }

  /** A plugin's request to apply a plugin-set change live — the skills plugin calls it after a
   *  CreateSkill/DeleteSkill tool or skills-API write hits disk. From inside a turn it is coalesced
   *  onto a flag and drained when the turn settles (reloading synchronously would tear down the
   *  session running the tool); with no turn in flight — an HTTP-triggered plugin route — nothing
   *  would ever drain the flag, so the reload starts right away in the background instead. */
  requestPluginReload(): void {
    this.pendingPluginReload = true;
    if (this.busy().turns === 0) this.drainDeferredPluginReload();
  }

  /** Post-turn hook (fired from the turn runner once a turn has fully settled): if a plugin requested a
   *  reload mid-turn, apply it now on the freed session. reloadPlugins is idempotent + serialized, so a
   *  concurrent turn draining the same flag just no-ops here (the flag is cleared before the reload). */
  private drainDeferredPluginReload(): void {
    if (!this.pendingPluginReload) return;
    this.pendingPluginReload = false;
    void this.reloadPlugins().catch((e) => logger('brain').error(`deferred plugin reload failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  /** Push a proactive message out through the platform adapters (cron/tick echoes).
   *  `notice` is set only for the host's own standing announcements, which an adapter may translate; a
   *  cron echo carries none and is delivered as written. */
  async notify(text: string, channelId?: string, notice?: ServiceNotice): Promise<void> {
    await this.platforms.notify(text, channelId, notice);
  }

  /** Start every plugin-contributed platform adapter — see PlatformOrchestrator. `only` narrows it to
   *  named platforms: the sub-agent runner starts the `subagent` adapter alone, because that adapter is
   *  how delegation is wired at all (without `listen` being called its `run` handle stays null and a
   *  nested delegation fails outright), while a second Discord/WhatsApp gateway from a child process
   *  would answer the operator's rooms twice. */
  async startPlatforms(log?: { info(m: string): void; error(m: string): void }, only?: readonly string[]): Promise<void> {
    // Share the reload lock so a toggle racing the initial start observes one settled lifecycle: either
    // the reload validates first and this starts its generation, or this starts first and the reload cycles
    // the same runtime shape. A repeated start is a no-op, never duplicate gateways.
    await this.serial('plugins-reload', async () => {
      if (this.pluginRuntimeStarted) return;
      // Plugin background services belong ONLY to the full daemon: a runner narrowed to `only` platforms
      // must not grow a second mission engine / sweeper fleet beside the daemon's.
      if (!only) await this.pluginServices.runBootReconciles();
      await this.platforms.startAll(log, only);
      if (!only) await this.pluginServices.startAll();
      this.pluginServicesStarted = !only;
      this.pluginPlatformFilter = only ? [...only] : undefined;
      this.pluginRuntimeStarted = true;
    });
  }

  /** Execute ONE delegated turn in THIS process. The single delegated entry point: the daemon reaches it
   *  through the dispatch when the runner is off, and the runner calls it for a turn that arrived over
   *  IPC — so both compose the child's session from the same builder. */
  async runDelegatedTurn(request: DelegatedTurnRequest, text: string, onEvent?: (e: BrainEvent) => void): Promise<string> {
    return this.channelService.send(
      delegatedChannelSendOpts(request, { policyForProjects: this.d.policyForProjects, identity: this.identity }, onEvent),
      text,
    );
  }

  /** Abort a channel session's in-flight turn and its delegated descendants — the same teardown a
   *  platform `/stop` does. Used by the sub-agent runner to carry out the daemon's abort verb. */
  async abortChannel(channelId: string): Promise<void> {
    await this.channelService.abort(channelId);
  }

  /** Steer a parent's follow-up into a delegated child turn RUNNING in this process, resolving only once
   *  the message is confirmed in (or confirmed absent from) the child's context. Used by the sub-agent
   *  runner to carry out the daemon's steer verb — the daemon has already authorized the caller. */
  async steerChannel(channelId: string, text: string): Promise<DelegatedSteerOutcome> {
    return this.channelService.steerDelegatedTurn(channelId, text);
  }

  /** Drop the live record for a channel (its transcript stays in SQLite and rehydrates on the next turn),
   *  serialized against that channel's own turns. The sub-agent runner does this when the daemon reclaims
   *  a child so it can run that child's next turn itself. */
  async disposeChannel(channelId: string): Promise<void> {
    await this.sessions.withLock(channelSessionId(channelId), async () => {
      this.sessions.channelDispose(channelId);
    });
  }

  /** Report every delegated parent→child edge this process registers, so a runner can mirror its NESTED
   *  tree into the daemon's authoritative registry. Late-bound because the reporter is the IPC channel,
   *  which is wired after the brain is built. */
  attachDelegatedEdgeReporter(report: (parentSessionId: string, childSessionId: string, running: boolean) => void): void {
    this.delegatedEdgeReporter = report;
  }

  /** Mirror a NESTED delegated edge reported by the sub-agent runner into this process's registry. The
   *  abort tree, `/stop` and the graceful-shutdown gate are authoritative here, so they have to see the
   *  work happening over there. The edge of a dispatched turn itself is NOT reported that way — the
   *  dispatch registers it synchronously before forwarding (see ChannelSessionService.sendRemote). */
  mirrorRemoteChildEdge(parentSessionId: string, childSessionId: string, running: boolean): void {
    this.sessions.setChildRunning(parentSessionId, childSessionId, running);
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
  messagesOf(userId: number, sessionId: string, opts: { anyOwner?: boolean } = {}): BrainMessageView[] {
    return this.statusView.messagesOf(userId, sessionId, opts);
  }

  /** A backwards-paged window over a conversation's history (chat lazy-load) — see
   *  BrainStatusService.messagesPage. */
  messagesPage(userId: number, sessionId: string | undefined, opts: MessagePageOpts, access: { anyOwner?: boolean } = {}): MessagePage {
    return this.statusView.messagesPage(userId, sessionId, opts, access);
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
