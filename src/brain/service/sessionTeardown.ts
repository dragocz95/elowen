import type { BrainStore } from '../../store/brainStore.js';
import type { PluginRegistry } from '../../plugins/registry.js';
import { logger } from '../../shared/logger.js';
import type { CardRegistry } from '../cards.js';
import type { InlineArtifactRegistry } from '../inlineArtifacts.js';
import type { ChannelSessionService } from '../channels.js';
import type { ElicitationRegistry } from '../elicitation.js';
import { processRegistry } from '../processRegistry.js';
import { abortSessionWork } from '../session/abortSessionWork.js';
import { SESSION_IDLE_ROLLOVER_MS } from '../session/idleRollover.js';
import type { LiveBrain } from '../session/liveBrain.js';
import type { LiveSessionRegistry, PendingAbort } from '../session/liveRegistry.js';
import { clearDeliveredUserEchoes } from '../session/queueMirror.js';
import { channelIdOf, isChannelSession, isNonUserSession, isOwnedUserSession } from '../sessionId.js';
import type { ClientAttachments } from './attachments.js';
import type { GoalLoopService } from './goalLoop.js';
import type { ConversationLifecycle } from './lifecycle.js';
import type { IdleSessionClock } from './liveSessionReaper.js';
import { sessionHasWorkInFlight, sparedChildSessionIds } from './sessionQuiescence.js';
import { resetConversationActivity } from '../session/conversationActivity.js';

interface SessionTeardownDeps {
  store: BrainStore;
  sessions: LiveSessionRegistry<LiveBrain>;
  attachments: ClientAttachments;
  elicitation: ElicitationRegistry;
  goals: GoalLoopService;
  cards: CardRegistry;
  artifacts?: Pick<InlineArtifactRegistry, 'closeSession'>;
  channelService: ChannelSessionService;
  lifecycle: ConversationLifecycle;
  idleClock: IdleSessionClock;
  /** Read live via the ONE shared BrainDeps object, never captured by value. */
  resolvePlugins: () => Promise<PluginRegistry | undefined>;
  /** The chat-terminal teardown is attached to BrainService AFTER construction, so it is read through a
   *  getter each time — capturing it by value here would freeze in the unwired `undefined`. */
  onConversationActivityChanged?: (sessionId: string) => void;
}

/** The destructive session lifecycle, split out of BrainService: interrupting a running turn (Esc/Stop),
 *  the client-close stop, the idle-session reaper, and deleting/purging stored conversations. These share
 *  one machinery — the parent-abort fence, the child-sparing rule, workflow cancellation and the fail-closed
 *  idle predicate — so they live together rather than scattered across the facade. Every collaborator is the
 *  SAME instance the facade holds (passed by reference), so the session lock, attachment counts and card
 *  cache this service mutates are exactly the ones the facade and its other units observe. */
export class SessionTeardownService {
  private readonly store: BrainStore;
  private readonly sessions: LiveSessionRegistry<LiveBrain>;
  private readonly attachments: ClientAttachments;
  private readonly elicitation: ElicitationRegistry;
  private readonly goals: GoalLoopService;
  private readonly cards: CardRegistry;
  private readonly artifacts: Pick<InlineArtifactRegistry, 'closeSession'>;
  private readonly channelService: ChannelSessionService;
  private readonly lifecycle: ConversationLifecycle;
  private readonly idleClock: IdleSessionClock;
  private readonly resolvePlugins: () => Promise<PluginRegistry | undefined>;
  private readonly onConversationActivityChanged?: (sessionId: string) => void;
  constructor(deps: SessionTeardownDeps) {
    this.store = deps.store;
    this.sessions = deps.sessions;
    this.attachments = deps.attachments;
    this.elicitation = deps.elicitation;
    this.goals = deps.goals;
    this.cards = deps.cards;
    this.artifacts = deps.artifacts ?? { closeSession() {} };
    this.channelService = deps.channelService;
    this.lifecycle = deps.lifecycle;
    this.idleClock = deps.idleClock;
    this.resolvePlugins = deps.resolvePlugins;
    this.onConversationActivityChanged = deps.onConversationActivityChanged;
  }

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.sessions.withLock(key, fn);
  }

  /** Stop the streaming turn (the Esc key in chat clients) — on the active conversation, or on the
   *  caller's explicit `session` (a bound CLI). The agent settles into agent_end → the idle event, so
   *  subscribed clients wind down on their own. */
  async abort(userId: number, session?: string): Promise<void> {
    const b = session ? this.sessions.get(this.lifecycle.ownedUserSession(userId, session)) : this.lifecycle.activeLive(userId);
    if (!b) {
      // No live instance — but between a pause and its boot resume the conversation may still be PARKED
      // (marker + checkpointed queue), and Esc/Stop on it is the user cancelling that work: a durable
      // cancel, so the sweep does not resume a turn the user just killed, answered OK rather than
      // "brain not started" for a session that is plainly theirs.
      const parkedId = session ? this.lifecycle.ownedUserSession(userId, session) : this.lifecycle.activeSessionId(userId);
      if (this.store.getSession(parkedId)?.parked_at) {
        this.store.clearSessionPark(parkedId);
        this.store.discardPausedQueue(parkedId);
        resetConversationActivity(this.store, parkedId, undefined, this.onConversationActivityChanged);
        return;
      }
      throw new Error('brain not started');
    }
    // An explicit stop on a turn the pause parked (Esc before the resume ran) is the user
    // cancelling that work — releasing the hold lets the turn unwind as aborted, and the durable park
    // marker must go with it or the next boot would resume a turn the user just killed.
    this.store.clearSessionPark(b.sessionId);
    // Esc/Stop before the turn produced any output discards the just-sent user turn: delete its durable
    // row and tell clients to pull the bubble + restore its text to the composer. Decided synchronously,
    // before the first await — JS is single-threaded, so turnProducedOutput cannot change under us between
    // this read and arming the guard; a token still in flight is then dropped by the reducer's guard.
    // Only abort() (the explicit Esc/Stop) does this — stopSession (client disconnect) and interruptQueued
    // keep the turn, so this deliberately lives here and not in abortFenced/abortLive.
    const discard = !b.turnProducedOutput ? b.lastAdmitted : undefined;
    if (discard) b.discardingUserTurn = discard.durableId;
    try {
      await this.abortFenced(b, { origin: 'user_stop', reason: 'aborted' });
      if (discard) {
        // Delete the user row AND any partial assistant output the aborted turn's agent_end persisted:
        // projectEvent runs synchronously while abortFenced tears the run down, so a token that raced the
        // cancel can leave a fragment in the store. Removing only the user row would surface that fragment
        // as an answer with no question after a reconnect. deleteMessagesFrom clears the row and everything
        // after it in this turn.
        this.store.deleteMessagesFrom(b.sessionId, discard.durableId);
        b.replay.publish({ type: 'discard_user', durableId: discard.durableId, text: discard.text });
      }
    } finally {
      // Always release the guard, even if abortFenced threw — otherwise the reducer would keep dropping
      // every future content event (discardingUserTurn stays armed) and the session would go mute until a
      // respawn, and a stale lastAdmitted could let a later abort delete a turn that already has output.
      if (discard) { b.discardingUserTurn = undefined; b.lastAdmitted = undefined; }
    }
  }

  /** Delegates to the shared helper — see sessionQuiescence.ts. Kept as a method because the facade
   *  (isBindQuiescent) and the abort cascade below both reach it through this service. */
  sparedChildSessionIds(parentSessionId: string): Set<string> {
    return sparedChildSessionIds(this.store, parentSessionId);
  }

  /** Stop the workflow engine for an aborted origin BEFORE its children are torn down: the engine would
   *  otherwise launch every ready node the moment an aborted one settles — fresh child sessions born
   *  after the abort, which nothing tears down (the user-visible symptom: Esc-Esc, workflow keeps going). */
  async cancelWorkflowsFor(sessionId: string): Promise<void> {
    const registry = await this.resolvePlugins();
    registry?.control('workflow')?.cancelForSession({ sessionId });
  }

  /** Shared destructive half of stop and queue-interrupt. Caller owns the parent-abort fence. */
  async abortLive(b: LiveBrain, abort: PendingAbort = { origin: 'parent_teardown', reason: 'aborted' }): Promise<void> {
    this.goals.cancelGoalContinuation(b.sessionId);
    b.session.clearQueue();
    clearDeliveredUserEchoes(b);
    if (b.sessionId) this.elicitation.cancelForSession(b.sessionId, 'aborted');
    await this.cancelWorkflowsFor(b.sessionId);
    // Spare detached/background children; abort only the foreground delegates bound to this turn.
    const spared = this.sparedChildSessionIds(b.sessionId);
    const children = new Set([
      ...this.sessions.childrenOf(b.sessionId),
      ...(abort.origin === 'user_stop' ? this.store.recoveringSubagentSessionIds(b.sessionId) : []),
    ]);
    const doomed = [...children].filter((child) => !spared.has(child));
    await Promise.all(doomed
      .filter((child) => isChannelSession(child))
      .map((child) => this.channelService.abort(channelIdOf(child), abort)));
    // Deregister ONLY the doomed children — a spared child MUST stay registered so it keeps counting toward
    // emitSubagent/status/reconcile/hasActiveChildren (channel eviction, /status, running-subagents block).
    for (const child of doomed) this.sessions.setChildRunning(b.sessionId, child, false);
    await abortSessionWork(b.session);
    b.session.clearQueue();
    clearDeliveredUserEchoes(b);
  }

  /** `abortLive` behind the parent-abort fence — the one entry point every caller that already HOLDS the
   *  live record uses. Fence before the child snapshot is taken inside: otherwise an idle drill-in
   *  continuation can register a fresh child between childrenOf() and the deregistration of the doomed
   *  ones, escaping this stop tree. */
  private async abortFenced(b: LiveBrain, abort: PendingAbort = { origin: 'parent_teardown', reason: 'aborted' }): Promise<void> {
    this.sessions.beginParentAbort(b.sessionId, abort);
    try {
      await this.abortLive(b, abort);
    } finally {
      this.sessions.endParentAbort(b.sessionId);
    }
  }

  /** Whether a client-initiated stop may interrupt this session's turn (Invariant 2). A detaching client
   *  must not abort a turn ANOTHER interactive client is watching. A stable client id identifies a terminal
   *  ending its own run, so only another stable client — or one mid-boot, which is on its way to watch —
   *  holds it off; an anonymous web-dock subscription merely watches and does not own the turn, so letting
   *  it veto meant an open browser tab silently disabled ctrl+c. A caller with no id cannot be told apart
   *  from a passive stream, so it keeps the conservative any-attachment rule. */
  private mayAbortOnStop(sessionId: string, clientId?: string): boolean {
    if (this.attachments.hasPendingStartClaim(sessionId)) return false;
    return clientId
      ? !this.attachments.hasLiveStableClient(sessionId)
      : this.attachments.attachedCount(sessionId) === 0;
  }

  /** Whether this conversation has no work in flight — the shared fail-closed predicate (see
   *  sessionQuiescence.ts), also consulted by the turn runner's cold-start compaction so "safe to
   *  destroy" and "safe to rewrite the context" can never drift apart. A missing live record is idle
   *  here: there is nothing live for the teardown to protect. */
  private sessionIsIdle(sessionId: string): boolean {
    return !sessionHasWorkInFlight(
      { store: this.store, sessions: this.sessions, elicitation: this.elicitation },
      sessionId,
    );
  }

  /** Final teardown of one live conversation, shared by the last-watcher stop and the idle reaper. The
   *  caller owns the `markDisposing` guard and the session lock. */
  private disposeLiveSession(sessionId: string, reason: string): void {
    this.goals.cancelGoalContinuation(sessionId);
    this.elicitation.cancelForSession(sessionId, reason);
    this.cards.clearSession(sessionId);
    this.sessions.dispose(sessionId);
  }

  /** A CLI is closing: stop its bound run and release the live PI session unless another INTERACTIVE
   *  client (one identifying itself with a stable client id) is still on this conversation. A passive
   *  web-dock subscription does not hold the turn open — it only watches. History stays in SQLite and can
   *  be resumed. Idempotent for an already-stopped conversation.
   *
   *  `detachOnly` (the web beacon) keeps the binding release but refuses the destructive half unless the
   *  conversation is idle: closing the last browser tab over a RUNNING agent must never kill it — that is
   *  what the Stop button is for. The abandoned runtime is collected later by reapIdleLiveSessions. The
   *  CLI omits the flag and keeps its original semantics (closing the terminal aborts its own run). */
  async stopSession(userId: number, session?: string, clientId?: string, clientGeneration?: number, opts?: { detachOnly?: boolean }): Promise<{ stopped: boolean; disposed: boolean }> {
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
      // The caller's own attachment was released above, so a zero count now unambiguously means no other
      // observer. A detaching client MUST NOT abort a turn another client is still watching (Invariant 2):
      // only the last watcher leaving may abort + dispose. Legacy callers without a stable id retain the
      // conservative behavior — only an already-detached stream can make the count zero.
      // A claimed-but-not-yet-streaming start counts as an observer. It is a client mid-boot — a `--resume`
      // that has been handed the session and is still opening its SSE — and counting only live streams
      // disposes the conversation out from under it, leaving its stream dark until some later send
      // respawns. availableForDefaultStart already treats a claim as occupancy for the same reason.
      // Same predicate the pre-lock abort used, re-evaluated because a client can attach while this waited
      // on the session lock. Deciding it twice with two copies of the rule is how they drift apart.
      if (!this.mayAbortOnStop(sessionId, clientId)) return { stopped: true, disposed: false };
      // A detaching web tab may release its binding but never tear down work in flight.
      if (opts?.detachOnly && !this.sessionIsIdle(sessionId)) return { stopped: false, disposed: false };
      // From here the record stays registered while we await, but it is doomed. Mark it so a concurrent
      // ensureLive() queues on the session lock and respawns behind the dispose, instead of fast-pathing
      // onto a handle this teardown is about to throw away.
      this.sessions.markDisposing(sessionId);
      // Everything from the mark to the dispose runs under this guard: dispose() clears the marker itself,
      // and the abandoned-teardown path clears it explicitly, but a throw in between (a goal, elicitation
      // or card teardown) would strand it — pinning a perfectly healthy session on the slow path forever.
      try {
        // Abort through the record this teardown already holds, NOT the public abort(): that one throws a
        // bare 'brain not started' for an already-settled conversation, so catching it here also swallowed
        // a REAL failure — a workflow that refused to cancel, a foreground delegate that stayed up, a PI
        // turn that never unwound — and disposed the parent anyway, leaving that work running with nothing
        // above it. Nothing live to abort is the only benign case, and it cannot happen under this lock.
        await this.abortFenced(live);
        // Re-check after the abort settles: a client can attach during that await, and it must not be
        // disposed out from under. If one arrived, leave the (now idle) session live for the new observer.
        // Deliberately NOT counting a pending claim here, unlike the gate above: a start that arrives once
        // the teardown is already committed is expected to queue on the session lock and respawn behind the
        // dispose — that ordering is the whole point of the disposing marker, and honouring the claim here
        // would hand it the very record the teardown is about to drop.
        if (this.attachments.attachedCount(sessionId) !== 0) {
          this.sessions.clearDisposing(sessionId); // teardown abandoned — the record is healthy again
          return { stopped: true, disposed: false };
        }
        this.disposeLiveSession(sessionId, 'client closed');
      } catch (e) {
        this.sessions.clearDisposing(sessionId);
        throw e;
      }
      // A conversation nobody ever typed into leaves with the session it was the identity of, rather than
      // lingering as an untitled shell until some later `/new` sweeps it up.
      this.lifecycle.dropIfUnspoken(sessionId);
      return { stopped: true, disposed: true };
    };
    // Reserve the bare session lock BEFORE any wait/ownership lookup. `settled(bound)` outside this lock
    // can race a replacement start (and can deadlock when that lifecycle holder waits on this cleanup).
    // Once queued here, a start either finishes first and this stops that exact live instance, or waits
    // behind us and creates a fresh one only after the old instance was disposed.
    const target = bound
      ? this.lifecycle.ownedUserSession(userId, bound)
      : session ? this.lifecycle.ownedUserSession(userId, session) : this.lifecycle.activeSessionId(userId);
    // Interrupt the in-flight work BEFORE queueing on the session lock. A running turn HOLDS that lock, so
    // a teardown that serializes first waits for the very turn it exists to interrupt: ctrl+c did nothing
    // until the work ended on its own. (`/stop` never had the bug — it calls abort() straight out.)
    // Only the PI-level interrupt, never the full abort(): abort() throws on an already-stopped session
    // and stopSession must stay idempotent. The serialized teardown below still does the real cascade.
    const runningLive = this.sessions.get(target);
    // A detach-only stop never interrupts: it may only reach the teardown below for an IDLE session, and
    // an idle session has no turn to interrupt. Skipping it here is what keeps the beacon non-destructive
    // — this pre-lock signal lands before `cleanUp` can veto anything.
    if (!opts?.detachOnly && runningLive && this.mayAbortOnStop(target, clientId)) {
      // Signal only — deliberately NOT awaited, so cleanUp reserves the lock in THIS tick. Awaiting would
      // let a start arriving during the interrupt take the lock first, breaking "a start racing a teardown
      // respawns behind the dispose". This DOES leave a window where the turn is dying but the session is
      // not yet marked disposing (the marker is set under the lock): what closes it is cleanUp re-checking
      // claims and attachments, not the marker. Note the cost — a veto there can no longer save the turn,
      // because the interrupt has already landed.
      // A turn parked on AskUserQuestion or a permission prompt is NOT PI-level work: the agent loop is
      // awaiting the tool's own promise and only re-checks the abort signal once that settles, so the
      // interrupt below cannot unwind it and the lock would stay held until the question is answered or
      // times out (5 min by default). Release the parked turn first — synchronous, so the lock is still
      // reserved in this tick. abortLive does the same in the same order for the same reason.
      this.elicitation.cancelForSession(target, 'client closed');
      void abortSessionWork(runningLive.session).catch((err: unknown) => {
        // The serialized abort below normally reports the outcome — but if this interrupt is what failed,
        // the turn may never release the lock and the teardown silently waits it out again. Leave a trace.
        logger('brain').warn(`stop ${target}: interrupt failed — ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    return this.serial(target, async () => cleanUp(target));
  }

  /** Whether this live conversation is a candidate for the idle reaper right now: no client watching it
   *  in any form, and no work in flight. Channel/task sessions are excluded — they have their own LRU. */
  private reapableNow(sessionId: string): boolean {
    if (isNonUserSession(sessionId)) return false;
    if (!this.sessions.has(sessionId) || this.sessions.isDisposing(sessionId)) return false;
    if (this.sessions.isActiveChild(sessionId)) return false;
    if (this.attachments.attachedCount(sessionId) !== 0) return false;
    if (this.attachments.hasLiveStableClient(sessionId) || this.attachments.hasPendingStartClaim(sessionId)) return false;
    return this.sessionIsIdle(sessionId);
  }

  /** Periodic sweep (daemon bootstrap, 60s): dispose live PI sessions that nobody has watched and nothing
   *  has run in for a full SESSION_IDLE_ROLLOVER_MS. This is the counterpart of the non-destructive web
   *  stop — a client's binding expires on its own TTL, but before this nothing ever released the RUNTIME,
   *  so a tab closed over a running agent leaked its session until the daemon restarted. Returns the ids
   *  reaped. History stays in SQLite; the next message respawns the conversation. */
  async reapIdleLiveSessions(now: number = Date.now()): Promise<string[]> {
    const due = this.idleClock.due(
      this.sessions.liveEntries().map(([sessionId]) => ({ sessionId, reapable: this.reapableNow(sessionId) })),
      now,
      SESSION_IDLE_ROLLOVER_MS,
    );
    const reaped: string[] = [];
    for (const sessionId of due) {
      const idleFor = now - (this.idleClock.reapableSince(sessionId) ?? now);
      await this.serial(sessionId, async () => {
        // Re-check under the lock: a client can attach, or a turn start, while earlier reaps awaited.
        if (!this.reapableNow(sessionId)) return;
        this.sessions.markDisposing(sessionId);
        try { this.disposeLiveSession(sessionId, 'idle session reaped'); }
        catch (e) { this.sessions.clearDisposing(sessionId); throw e; }
        this.idleClock.forget(sessionId);
        reaped.push(sessionId);
        logger('brain').info(`reaped idle live session ${sessionId} (unwatched and idle for ${Math.round(idleFor / 60_000)}m)`);
      });
    }
    return reaped;
  }

  /** Delete one of the user's stored conversations (never a channel session, never someone else's).
   *  A live session is disposed first; deleting the active conversation just clears the pointer —
   *  the next start() falls back to the most recent remaining one.
   *
   *  Serialized on the session lock, like every neighbouring path that mutates one conversation
   *  (compact, stopSession, the idle reaper, bindChannelContext). Unserialized, the teardown interleaved
   *  with a prompt() already running inside that lock: the delete disposed the live record and dropped
   *  the row while the turn ran on, and that turn's own agent_end then persisted its output into a
   *  conversation that no longer existed. The in-flight work is fenced and interrupted BEFORE queueing on
   *  the lock — a running turn HOLDS it, so serializing first would make the delete wait out the very
   *  turn it exists to destroy (the ordering stopSession uses, for the same reason). */
  async deleteSession(userId: number, sessionId: string): Promise<void> {
    const row = this.store.getSession(sessionId);
    if (!isOwnedUserSession(row, userId, sessionId)) throw new Error('unknown session');
    this.fenceDeletedSession(sessionId);
    await this.serial(sessionId, async () => {
      // Re-read under the lock: a concurrent delete of the same conversation may already have completed,
      // and running the teardown a second time would tear down whatever took this id in the meantime.
      if (!isOwnedUserSession(this.store.getSession(sessionId), userId, sessionId)) {
        this.sessions.clearDisposing(sessionId); // teardown abandoned — don't pin a live record on the slow path
        return;
      }
      this.teardownDeletedSession(userId, sessionId);
      this.store.deleteSession(sessionId);
    });
  }

  /** Fence a conversation whose delete is COMMITTED, in the same tick the caller reserves its session
   *  lock. `markDisposing` is what keeps a concurrent ensureLive() from fast-pathing onto the record this
   *  delete is about to throw away — it queues on the lock instead, where the row is already gone and
   *  every bound entry point rejects the id. Releasing the parked question and interrupting PI's run is
   *  what lets a turn holding that lock reach the end of it rather than run to completion first; a turn
   *  parked on AskUserQuestion is not PI-level work, so no interrupt can unwind it (see stopSession).
   *  Both are signals only, deliberately not awaited, so the lock is still reserved in this tick. */
  private fenceDeletedSession(sessionId: string): void {
    const live = this.sessions.get(sessionId);
    if (!live) return;
    this.sessions.markDisposing(sessionId);
    this.elicitation.cancelForSession(sessionId, 'conversation deleted');
    void abortSessionWork(live.session).catch((err: unknown) => {
      // Nothing else reports this one: it runs before the lock and nothing awaits it, so a failed
      // interrupt would silently turn the delete back into "wait out the turn".
      logger('brain').warn(`delete ${sessionId}: interrupt failed — ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** Everything a conversation owns, released before its row is dropped — shared by the user-facing
   *  delete and the admin one so the two cannot drift apart (they already had: only one of them cleared
   *  the active pointer and the card cache, so an admin delete of the active conversation left
   *  `activeSessionId` naming a row that no longer existed).
   *
   *  A delete spares nothing, unlike a stop: a detached delegate or a background workflow keeps burning
   *  tokens for an inbox that has ceased to exist. */
  private teardownDeletedSession(userId: number, id: string): void {
    this.cleanupProcessesForTree(id);
    this.cancelDelegatedWorkFor(id);
    this.elicitation.cancelForSession(id, 'conversation deleted'); // release a parked turn before dropping its session
    this.goals.cancelGoalContinuation(id);
    this.artifacts.closeSession(id);
    this.cards.clearSession(id);
    if (isChannelSession(id)) this.sessions.channelDispose(channelIdOf(id));
    else this.sessions.dispose(id);
    // The in-memory pointer must not survive the row it names, or status/send would keep answering for a
    // conversation that no longer exists (lifecycle.activeSessionId trusts the pointer verbatim).
    if (this.sessions.activeIdFor(userId) === id) this.sessions.clearActive(userId);
  }

  /** Stop the DELEGATED work a deleted conversation is still driving: the workflow DAG that keeps
   *  launching fresh nodes into it, and every running delegated child whose result now has nowhere to be
   *  delivered. cleanupProcessesForTree reaches only the shell processes those children spawned, never
   *  the agent turns themselves.
   *
   *  Fired and logged rather than awaited: the workflow control lives behind the plugin registry (async)
   *  while neither delete entry point awaits it — the same contract the terminal teardown above uses.
   *  Cancel the engine BEFORE the children, or it relaunches a node the moment an aborted one settles. */
  private cancelDelegatedWorkFor(id: string): void {
    const children = this.sessions.childrenOf(id);
    void (async () => {
      await this.cancelWorkflowsFor(id);
      for (const child of children) {
        if (isChannelSession(child)) await this.channelService.abort(channelIdOf(child), { origin: 'parent_teardown', reason: 'conversation deleted' });
        this.sessions.setChildRunning(id, child, false);
      }
    })().catch((e) => logger('brain').error(`delegated teardown failed for ${id}`, e));
  }

  /** Delete ANY of the owner's brain sessions by id (admin panel) — disposing a live conversation or
   *  channel session first. Deliberately bypasses the isNonUserSession guard: this IS the management
   *  surface. Returns how many were deleted (0 or 1). */
  deleteManagedSession(userId: number, id: string, scope: 'own' | 'any' = 'own'): number {
    const row = this.store.getSession(id);
    if (!row) return 0;
    // `any` is the admin oversight register, which spans every account; `own` stays the default so a
    // caller reaches across accounts only by saying so. Teardown runs as the session's REAL owner --
    // passing the admin here would clean up the wrong user's terminals and processes.
    if (scope === 'own' && row.user_id !== userId) return 0;
    this.teardownDeletedSession(row.user_id, id);
    this.store.deleteSession(id);
    return 1;
  }

  private cleanupProcessesForTree(id: string): void {
    const stack = [id];
    for (let index = 0; index < stack.length; index += 1) {
      const sessionId = stack[index]!;
      processRegistry.killSession(sessionId);
      for (const child of this.store.getSubagentRuns(sessionId)) stack.push(child.sessionId);
    }
  }

  /** Every delegated descendant session id under `id` (breadth-first via the sub-agent run tree), the
   *  root excluded. The janitor uses this to purge a stale conversation's sub-agent transcripts WITH it —
   *  deleteSession only detaches children to top-level, where their `brain-ch-` prefix then excludes them
   *  from staleConversationIds forever, leaking the transcripts. */
  private descendantSessionIds(id: string): string[] {
    const out: string[] = [];
    const stack = [id];
    for (let index = 0; index < stack.length; index += 1) {
      for (const child of this.store.getSubagentRuns(stack[index]!)) { out.push(child.sessionId); stack.push(child.sessionId); }
    }
    return out;
  }

  /** Delete ALL of the owner's brain sessions (the panel's "delete everything" — the client confirms).
   *  Returns the count removed. */
  deleteAllManagedSessions(userId: number, scope: 'own' | 'any' = 'own'): number {
    // The rows deleted are exactly the rows the caller was looking at: `own` walks their own list, `any`
    // walks the cross-account register. Anything else makes "delete all" delete some. `own` stays the
    // DEFAULT because the other caller is account deletion (routes/auth.ts), where reaching across
    // accounts would wipe the instance instead of one person's history.
    const rows = scope === 'any' ? this.store.listAllSessionsWithOwner() : this.store.listSessions(userId);
    let n = 0;
    for (const s of rows) n += this.deleteManagedSession(userId, s.id, scope);
    return n;
  }

  /** Retention janitor: delete this user's own idle top-level conversations older than `days`. The store
   *  query already excludes non-user shells, delegated children and unspoken rows; here we add the live
   *  exclusions it cannot see — a running session, the user's active conversation, any session whose
   *  sub-agent is still running (deleting it would kill that child), and any conversation a PENDING cron
   *  wake-up was scheduled FROM (purging it would strand the wake-up's context and demote its reply to
   *  the notification channel). Returns the count removed. */
  async purgeStaleSessionsForUser(userId: number, days: number): Promise<number> {
    // The cronjob plugin owns the wake-up jobs, so ask through its typed control; with the plugin
    // disabled/absent no control is registered → nothing to protect. A failed plugin LOAD rejects
    // instead — fail closed (the sweep skips, the caller logs) rather than delete a conversation a
    // wake-up may still need.
    const cron = (await this.resolvePlugins())?.control('cron');
    const pendingOrigins = new Set(cron?.pendingWakeupOriginSessionIds(userId) ?? []);
    const activeId = this.lifecycle.activeSessionId(userId);
    let n = 0;
    for (const id of this.store.staleConversationIds(userId, days)) {
      if (id === activeId || pendingOrigins.has(id)) continue;
      if (this.sessions.has(id) || this.sessions.hasActiveChildren(id)) continue;
      // Purge the whole delegated tree, not just the root: collect the sub-agent descendants FIRST (before
      // deleteSession detaches them), then delete each. Otherwise their transcripts leak forever.
      for (const descId of this.descendantSessionIds(id)) n += this.deleteManagedSession(userId, descId);
      n += this.deleteManagedSession(userId, id);
    }
    return n;
  }
}
