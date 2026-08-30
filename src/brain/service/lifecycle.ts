import { realpathSync } from 'node:fs';
import type { Policy } from '../../plugins/policy.js';
import type { BrainStore } from '../../store/brainStore.js';
import type { ElicitationRegistry } from '../elicitation.js';
import type { BrainEvent } from '../events.js';
import { sendLockKey, type LiveSessionRegistry } from '../session/liveRegistry.js';
import type { LiveBrain, SpawnOpts } from '../session/liveBrain.js';
import { rolloverDue } from '../session/idleRollover.js';
import { decideVisionHop } from '../visionFallback.js';
import { catalogModelVision } from '../modelCapabilities.js';
import { defaultUserSessionId, freshUserSessionId, isNonUserSession, isOwnedUserSession, isChannelSession, channelIdOf } from '../sessionId.js';
import type { BrainDeps } from '../brainDeps.js';
import type { CardRegistry } from '../cards.js';
import type { ClientAttachments } from './attachments.js';
import type { GoalLoopService } from './goalLoop.js';
import { clientDir, gitProjectRoot } from './workDir.js';
import { recordSessionEvent } from './sessionEvents.js';
import { sessionHasWorkInFlight } from './sessionQuiescence.js';
import { hasActiveNativeCompactionCheck } from '../session/compactionCheckCoordinator.js';

/** Prompt state that survives an IN-PLACE respawn — switchModel, restart and the vision hop all rehydrate
 *  the SAME conversation from SQLite.
 *
 *  The dividing line is what a field CLAIMS. `lastTurnMode` is a fact about the conversation ("the last
 *  turn ran in plan mode") and a respawn does not change the mode, so carrying it prevents a spurious
 *  "the mode just changed" directive on the next turn.
 *
 *  The cadence counters used to be carried too, and should not have been: they are claims about what the
 *  model can still READ. A rehydrated transcript is rebuilt from the clean stored user rows —
 *  `persistAgentRun` reuses the pre-projected text precisely so PI's ephemeral framing never becomes
 *  durable history — so the full mode directive and the post-compaction orientation block are genuinely
 *  gone. Carrying their cadence made the sparse reminder tell the model "the full instructions are
 *  earlier in this conversation" when they were not, and suppressed an orientation block the transcript
 *  no longer contained. Resetting costs one full directive per model switch, and it is the same answer
 *  the memory dedup set and the ambient digests give to the identical question.
 *
 *  Also deliberately excludes `yoloOverride` and the pending reasoning marker — their own field docs say a
 *  respawn resets them to the persisted default — and is never used by rollover, which opens a brand-new
 *  EMPTY conversation (see maybeRollover). */
interface InPlaceRespawnState {
  lastTurnMode: LiveBrain['lastTurnMode'];
}

function captureInPlaceRespawnState(b: LiveBrain): InPlaceRespawnState {
  return { lastTurnMode: b.lastTurnMode };
}

function applyInPlaceRespawnState(fresh: LiveBrain, state: InPlaceRespawnState): void {
  fresh.lastTurnMode = state.lastTurnMode;
}

interface LifecycleDeps {
  store: BrainStore;
  /** The shared live-session state (owned by the BrainService facade). */
  sessions: LiveSessionRegistry<LiveBrain>;
  attachments: ClientAttachments;
  elicitation: ElicitationRegistry;
  goals: GoalLoopService;
  /** The conversation's display cards (todo checklist) — `/clear` empties the panel with the history it
   *  belongs to, and the cache has to be evicted along with the rows it mirrors. */
  cards: Pick<CardRegistry, 'forSession' | 'clearSession'>;
  /** Session composition (LiveSessionSpawner.spawn) — the single spawn source. */
  spawn(opts: SpawnOpts): Promise<LiveBrain>;
  policy?: (userId: number) => Policy;
  userSettings?: BrainDeps['userSettings'];
  projectModelPreference?: BrainDeps['projectModelPreference'];
  setProjectModelPreference?: BrainDeps['setProjectModelPreference'];
  /** PermissionApprovalService.selectionAllowed — a saved model the user may no longer run falls back
   *  to the server default instead of blocking the brain. */
  selectionAllowed(userId: number, sel?: { provider?: string; model?: string }): boolean;
}

/** Conversation lifecycle: session addressing (the active pointer + explicit bound ids), start/resume
 *  resolution, spawn/respawn (ensureLive, restart, model switch, idle rollover, vision hop), the
 *  attachment surface (subscribe/tapSession) and the work-dir stamping that feeds default-start. */
export class ConversationLifecycle {
  constructor(private d: LifecycleDeps) {}

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.d.sessions.withLock(key, fn);
  }

  /** The user's current conversation id: the explicit active pointer, else their most recent stored
   *  session, else the legacy default id (first-ever conversation). Channel sessions never count. */
  activeSessionId(userId: number): string {
    const set = this.d.sessions.activeIdFor(userId);
    if (set) return set;
    const recent = this.d.store.listSessions(userId).find((s) => !isNonUserSession(s.id));
    return recent?.id ?? defaultUserSessionId(userId);
  }

  /** Authorize an EXPLICIT client-bound session id: it must be the caller's own conversation, never a
   *  channel/task session (mirrors the /brain/subagent/send validation). Returns the id or throws. */
  ownedUserSession(userId: number, sessionId: string): string {
    const row = this.d.store.getSession(sessionId);
    if (!isOwnedUserSession(row, userId, sessionId)) throw new Error('unknown session');
    return sessionId;
  }

  /** Resolve an explicit parent-stream target through the stable CLI attachment when it carries a
   * generation. A live idle rollover re-keys that attachment before the client has necessarily received
   * its `session` event, so the reconnect's old URL must land on the fresh replacement. Validate BOTH
   * ids as this user's ordinary conversation: a client binding is a routing hint, never an ownership
   * bypass. */
  resolveStreamSession(userId: number, sessionId: string, clientId?: string, clientGeneration?: number): string {
    // Drill-in taps deliberately reach an owned delegated/channel child as read-only history/live output.
    // They never carry a stable parent CLI identity, so validate ownership without the owner-chat-only
    // `isNonUserSession` restriction. A generation-bound parent stream below remains owner-chat only.
    const requested = this.d.store.getSession(sessionId);
    if (!requested || requested.user_id !== userId) throw new Error('unknown session');
    if (!clientId || clientGeneration === undefined) return sessionId;
    this.ownedUserSession(userId, sessionId);
    const resolved = this.d.attachments.resolveStreamSession(userId, clientId, clientGeneration, sessionId);
    if (!resolved.accepted) throw new Error('stale client stream');
    return this.ownedUserSession(userId, resolved.sessionId);
  }

  /** DEFAULT start resolution for a cwd-reporting client (the CLI): the most recent conversation whose
   *  stored work_dir matches the launch directory AND that no other client stream currently holds; else
   *  the most recent unattached cwd-less conversation (legacy/web sessions, so a lone CLI keeps resuming
   *  what it always resumed); else a brand-new one. Never grabs a conversation another live client is
   *  attached to — that is exactly the two-terminals bug this resolution exists to fix. */
  private resolveStartSession(userId: number, cwd: string): string {
    let real = '';
    try { real = realpathSync(cwd); } catch { /* vanished/unreadable dir — no cwd match possible */ }
    const rows = this.d.store.listSessions(userId).filter((s) => !isNonUserSession(s.id));
    const unattached = (s: { id: string }) => this.d.attachments.availableForDefaultStart(s.id);
    const match = real ? rows.find((s) => s.work_dir === real && unattached(s)) : undefined;
    if (match) return match.id;
    const legacy = rows.find((s) => !s.work_dir && unattached(s));
    return legacy?.id ?? freshUserSessionId(userId);
  }

  /** Drop this user's EMPTY conversations — ones that were opened and never spoken in. Now that launching
   *  the CLI always opens a blank conversation, a launch-and-quit (or a `/new` the user thought better of)
   *  leaves a row behind, and without this sweep the /resume picker would slowly fill with nothing.
   *
   *  Deliberately narrow: a conversation with even one stored message is never touched, and neither is one
   *  that is live, that any client stream holds, or that a start has already claimed — an empty conversation
   *  open in another terminal belongs to that terminal. `keep` is the conversation being started right now.
   *  An empty conversation has had no turn, so it owns no processes, goals or parked questions to clean up. */
  private pruneEmptyConversations(userId: number, keep: string): void {
    for (const row of this.d.store.listSessions(userId)) {
      if (row.id === keep) continue;
      this.dropIfUnspoken(row.id);
    }
  }

  /** Drop ONE conversation that was opened and never spoken in. The row is a live session's identity — the
   *  delegation parent check, the work-dir binding and every ownership check read it — so it is written the
   *  moment a session spawns. But a row nobody typed into is not a conversation, and once its session is
   *  gone there is nothing left for it to be the identity OF. Called when a session is disposed (a CLI
   *  quit), so the shell goes with it instead of waiting for the next `/new` to sweep it up.
   *
   *  Deliberately narrow: a conversation with even one stored message is never touched, and neither is one
   *  that is still live, that a client stream holds, or that a start has already claimed — an empty
   *  conversation open in another terminal belongs to that terminal. "No stored messages" is NOT "nothing
   *  happening": a turn can be in flight, parked on an AskUserQuestion, or driving a goal without having
   *  written a row yet, which is exactly why the live check is here. An unspoken conversation has had no
   *  turn, so it owns no processes, goals or parked questions to clean up. */
  dropIfUnspoken(sessionId: string): void {
    if (isNonUserSession(sessionId)) return;
    const row = this.d.store.getSession(sessionId);
    if (!row) return;
    if (this.d.store.lastMessageAt(sessionId) !== undefined) return;       // it was spoken in — keep it
    // A CLEARED conversation is empty on purpose: the user emptied a real conversation to carry on in it,
    // and the clear destroyed the very messages this check reads. `cleared_at` is what still says it was
    // used, so it is kept exactly like a spoken-in one (see brain_sessions.cleared_at).
    if (row.cleared_at) return;
    if (!this.d.attachments.availableForDefaultStart(sessionId)) return;   // a client is sitting in it
    if (this.d.sessions.has(sessionId)) return;                            // still live — not ours to remove
    this.d.store.deleteSession(sessionId);
    // The in-memory pointer must not survive the row it names, or status/history would keep answering for
    // a conversation that no longer exists. activeSessionId falls back to the most recent real one.
    if (this.d.sessions.activeIdFor(row.user_id) === sessionId) this.d.sessions.clearActive(row.user_id);
  }

  activeLive(userId: number): LiveBrain | undefined {
    return this.d.sessions.get(this.activeSessionId(userId));
  }

  /** The live record behind a session id, whichever registry bucket it lives in (user sessions are
   *  keyed by session id, channel sessions by channel id). */
  private liveFor(sessionId: string): LiveBrain | undefined {
    return this.d.sessions.get(sessionId)
      ?? (isChannelSession(sessionId) ? this.d.sessions.channelGet(channelIdOf(sessionId)) : undefined);
  }

  /** Start (or resume) a conversation. `session` resumes that stored conversation (ownership checked);
   *  `fresh` opens a brand-new one; a bare start with a client `cwd` (the CLI) resolves via
   *  `resolveStartSession` (cwd match, never a conversation another client holds); a bare start without
   *  one (the web dock) keeps following the active pointer. Either way it becomes the user's active
   *  conversation. Idempotent when the target is already live. */
  async start(userId: number, opts?: { provider?: string; model?: string; session?: string; fresh?: boolean; cwd?: string; clientId?: string; clientGeneration?: number }): Promise<{ sessionId: string }> {
    let sessionId: string;
    if (opts?.fresh) sessionId = freshUserSessionId(userId);
    else if (opts?.session) sessionId = this.ownedUserSession(userId, opts.session);
    else if (opts?.cwd) sessionId = this.resolveStartSession(userId, opts.cwd);
    else sessionId = this.activeSessionId(userId);
    const prevActive = this.d.sessions.activeIdFor(userId);
    // Claim synchronously, before ensureLive's first async boundary. Besides making Ctrl+C during start
    // target this requested conversation, claim() detaches only THIS client's old stream; the guard below
    // consequently sees any genuinely remaining terminal/web attachment and preserves its old driver.
    const claim = opts?.clientId
      ? this.d.attachments.claim(userId, opts.clientId, sessionId, opts.clientGeneration)
      : undefined;
    // A newer request from this same CLI identity already selected another target. This older network-
    // reordered request must not mutate the active pointer, old-driver cleanup, or spawn state at all.
    if (claim && !claim.accepted) {
      if (claim.closed) throw new Error('client request is no longer current');
      return { sessionId: claim.sessionId };
    }
    const claimGeneration = claim?.generation;
    // Opening a blank conversation is also when the previous blank ones stop being worth keeping.
    if (opts?.fresh) this.pruneEmptyConversations(userId, sessionId);
    // A bound CLI can be following non-active A while another client has moved the global pointer to B.
    // Its stable binding, not that shared pointer, identifies the driver this switch actually leaves.
    const leavingSessionId = opts?.clientId ? claim?.previousSessionId : prevActive;
    // Switching AWAY from a conversation that's parked on an AskUserQuestion: release its question so
    // the abandoned turn settles and frees its session lock. ONLY when no other client stream is still
    // attached to it — a second terminal (or the dock) holding that conversation must keep its pending
    // ask and its running goal; the pointer moving away from THEM must never kill THEIR turn.
    if (leavingSessionId && leavingSessionId !== sessionId && this.d.attachments.attachedCount(leavingSessionId) === 0) {
      this.d.elicitation.cancelForSession(leavingSessionId, 'switched conversation');
      this.d.goals.cancelGoalContinuation(leavingSessionId);
      // Switching away stops the goal's only driver (the in-memory timer) — so don't leave the row saying
      // "active" while nothing runs. Pause it; the user resumes with /goal resume when they switch back.
      this.d.goals.reconcileGoal(leavingSessionId, 'interrupted (switched conversation)');
    }
    this.d.sessions.setActive(userId, sessionId);
    // NOTE: no reconcile of the TARGET goal here. Restart zombies are handled once at boot
    // (reconcileGoalsOnBoot); a timer-less goal on a start()/reconnect is usually a healthy mid-flight turn
    // (its timer self-deleted when it fired), so pausing it here would kill a running goal.
    try {
      await this.ensureLive(userId, sessionId, { provider: opts?.provider, model: opts?.model, clientCwd: opts?.cwd, explicitResume: !!opts?.session });
    } catch (error) {
      if (opts?.clientId && claimGeneration !== undefined) this.d.attachments.cancelClaim(userId, opts.clientId, claimGeneration);
      throw error;
    }
    if (opts?.clientId && claimGeneration !== undefined
      && !this.d.attachments.isCurrentClaim(userId, opts.clientId, claimGeneration)
      && this.d.attachments.claimedSession(userId, opts.clientId) !== sessionId
      && this.d.attachments.attachedCount(sessionId) === 0) {
      // Stop (or a newer switch elsewhere) consumed/superseded this claim while spawn was in flight.
      // Nothing follows the newly-live target, so do not leak a PI session after Ctrl+C already finished.
      this.d.goals.cancelGoalContinuation(sessionId);
      this.d.elicitation.cancelForSession(sessionId, 'client closed during start');
      this.d.sessions.dispose(sessionId);
    }
    return { sessionId };
  }

  /** Validate (or, after a daemon restart, reconstruct) the stable generation binding carried by a bound
   *  CLI request. A stop/cancel tombstone makes this false until a strictly newer start claims the id. */
  authorizeClientRequest(userId: number, clientId: string, generation: number, sessionId: string): boolean {
    return this.d.attachments.authorizeRequest(userId, clientId, sessionId, generation);
  }

  /** Make one conversation live (spawn if needed) WITHOUT touching the active pointer — the shared tail
   *  of start(), bound sends, goal continuations and respawns. `clientCwd` is a client-REPORTED launch
   *  directory (validated, then stamped as the session's work_dir); `spawnCwd` is an internal carry-over
   *  (respawn keeping its previous workDir) that must NOT be stamped — a cwd-less web session stays
   *  cwd-less. When neither is given (a cold respawn: daemon restart, plugin reload, last client
   *  detach) the session row's stored work_dir is restored instead — the conversation's durable home —
   *  and equally never stamped. Serialized per conversation: two concurrent spawns would leak one PI
   *  session. */
  async ensureLive(userId: number, sessionId: string, o: { provider?: string; model?: string; clientCwd?: string; spawnCwd?: string; explicitResume?: boolean; thinkingLevel?: string | null; reapplyModelPreference?: boolean } = {}): Promise<void> {
    // A HEALTHY live conversation needs no spawn, so it must not queue on the session lock to find that
    // out: a running turn holds that lock for its full duration (turnRunner), which would leave a
    // relaunched CLI unable to resume into its own in-flight work until the turn ended or was aborted.
    // A teardown in flight is the one case where the record is registered but doomed — it still has to
    // take the lock and respawn behind the dispose. Synchronous (no await), so no teardown can start
    // between the two reads.
    const healthy = this.d.sessions.get(sessionId);
    if (healthy && !this.d.sessions.isDisposing(sessionId)) {
      if (o.explicitResume) healthy.interactedAt = Date.now();
      return;
    }
    await this.serial(sessionId, async () => {
      // An EXPLICIT resume (the session picker / `/resume <id>`) is a deliberate choice to continue
      // that conversation — stamp it so the idle-rollover check in send() respects it. A default
      // start (client boot, no `session` opt) deliberately does NOT stamp: a stale conversation
      // auto-resumed by a reconnecting client must still roll over on the next message.
      const already = this.d.sessions.get(sessionId);
      if (already) {
        if (o.explicitResume) already.interactedAt = Date.now();
        return; // idempotent resume of a live conversation
      }
      // Model selection: an explicit start option wins, then the model this conversation was ALREADY
      // running on, then a Git-project pick, then the user's global override, then the configured
      // default. Each persisted candidate is validated so a model revoked from the user's allow-list
      // falls through rather than blocking the brain.
      const userCfg = this.d.userSettings?.(userId);
      const policy = this.d.policy?.(userId) ?? { allowedProjectIds: 'all' as const, allowedPaths: () => [] };
      // A respawn is ROUTINE — the last client detaching, a settings save, a plugin reload, the idle
      // reaper, a daemon restart all cause one — and each used to re-resolve the model from the global
      // or project preference, silently overwriting an explicit `/model` pick with no session event to
      // show for it. A conversation that has already been spoken in therefore keeps its own pair.
      // Requires BOTH ids: a model alone does not identify a provider, and resolveBrainModelRoute falls
      // back to providers[0] when none is given, which could restore the model against the wrong one.
      // Rows written before `provider` existed are simply skipped and heal on their next spawn.
      // Deliberately NOT applied to the vision model: `visionFallback` lives only in memory, so after a
      // restart the row still names a temporary hop and honouring it would make the hop permanent.
      // `reapplyModelPreference` is set by a restart that exists BECAUSE the model setting changed —
      // honouring the pin there would leave the user staring at a settings page reporting one model
      // while the chat kept running another. Only the MODEL is dropped by it — the row is still read,
      // because its work_dir feeds the cwd fallback below and the conversation's home directory is not
      // the model pin.
      const storedRow = this.d.store.getSession(sessionId);
      const storedModel = o.reapplyModelPreference ? undefined : storedRow?.model;
      const storedProvider = o.reapplyModelPreference ? undefined : storedRow?.provider;
      // A web turn carries no client cwd, and spawnCwd (the internal respawn carry-over) is equally
      // absent on a COLD respawn — without a fallback the spawn resolves the policy root / primary
      // project instead of the conversation's own home, which is exactly the wrong-repo bug this
      // restores. The stored work_dir is that home: it is only ever written from a VALIDATED client
      // report (stampWorkDir), so restoring it restores the conversation's own identity, never invents
      // one. Empty stays empty — a cwd-less row means "matches nowhere", not a path. The restored
      // directory must NOT be stamped back (the stamp below stays gated on o.clientCwd): it is not a
      // directory the CURRENT caller reported, and restamping would dress a cwd-less respawn up as
      // client-confirmed.
      const restoredWorkDir = storedRow?.work_dir || undefined;
      const resolvedCwd = o.clientCwd ?? o.spawnCwd ?? restoredWorkDir;
      // The restored directory feeds the project-model pick too: the spawn cwd and the project
      // preference must agree on which repo this conversation belongs to, and the preference is only
      // consulted when the conversation carries no model pin of its own, so a pinned conversation is
      // unaffected. A dir that vanished or fell outside the policy simply yields no project root — the
      // same graceful miss as a CLI client launching in a gone directory.
      const projectRoot = gitProjectRoot(policy, resolvedCwd);
      const stored = storedModel && storedProvider
        && storedModel !== userCfg?.visionModel
        // "Has this conversation been spoken in?" — the pin is only restored for one that has, so a
        // brand-new shell still follows the current preference. A CLEARED conversation counts: it WAS
        // spoken in, and the clear is what removed the messages this reads (see brain_sessions.cleared_at);
        // without that second half the first cold respawn after a /clear silently moves the conversation
        // off the model it was running on. Kept inside the same && chain so the store is still only
        // consulted once there is a pin worth restoring.
        && (this.d.store.lastMessageAt(sessionId) !== undefined || !!storedRow?.cleared_at)
        ? { provider: storedProvider, model: storedModel }
        : undefined;
      const candidates = [
        { provider: o.provider, model: o.model },
        stored,
        projectRoot ? this.d.projectModelPreference?.(userId, projectRoot) : undefined,
        { provider: userCfg?.modelProvider, model: userCfg?.model },
      ];
      let selection: { provider?: string; model?: string } = {};
      for (const candidate of candidates) {
        if (!candidate || (!candidate.provider && !candidate.model)) continue;
        if (this.d.selectionAllowed(userId, candidate)) { selection = candidate; break; }
      }
      const live = await this.d.spawn({
        sessionId,
        ownerUserId: userId,
        selection,
        policy,
        // `null` explicitly restores a session whose live reasoning level was unset; omitted keeps the
        // normal Account default. This distinction matters when returning from a temporary vision hop.
        thinkingLevel: o.thinkingLevel === null ? undefined : (o.thinkingLevel ?? userCfg?.thinkingLevel),
        autoCompact: !!userCfg?.autoCompact,
        clientCwd: resolvedCwd,
      });
      if (o.explicitResume) live.interactedAt = Date.now();
      this.d.sessions.set(sessionId, live);
      if (o.clientCwd) this.stampWorkDir(sessionId, o.clientCwd, policy);
    });
  }

  /** Persist the conversation ↔ launch-directory binding (feeds resolveStartSession). Only a VALIDATED
   *  client-reported directory is ever stamped — fallback-resolved workDirs (policy root, primary
   *  project) must not turn a cwd-less web session into a false cwd match. */
  stampWorkDir(sessionId: string, clientCwd: string, policy: Policy): void {
    const dir = clientDir(policy, clientCwd);
    if (!dir) return;
    const row = this.d.store.getSession(sessionId);
    if (row && row.work_dir !== dir) this.d.store.setWorkDir(sessionId, dir);
  }

  /** Switch a conversation to another configured model (the /model picker) — the active one, or the
   *  caller's explicit `session` (a bound CLI). Mirrors the channel pattern: dispose the live session
   *  and respawn on the new selection — history rehydrates from the store, so the conversation
   *  continues seamlessly. */
  async switchModel(userId: number, sel: { provider?: string; model?: string }, session?: string): Promise<{ model: string }> {
    if (!this.d.selectionAllowed(userId, sel)) throw new Error('model not allowed for user');
    const sessionId = session ? this.ownedUserSession(userId, session) : this.activeSessionId(userId);
    // A parked AskUserQuestion holds this session's serial lock — release it FIRST (outside the lock)
    // so the switch doesn't wait out the question's timeout.
    this.d.elicitation.cancelForSession(sessionId, 'model switched');
    this.d.goals.cancelGoalContinuation(sessionId);
    return this.serial(sessionId, async () => {
      const previous = this.d.sessions.get(sessionId);
      const prevWorkDir = previous?.workDir; // the switch must not move the session cwd
      // In-place respawn: the model switch rehydrates the SAME durable conversation, so the last mode fact
      // survives — see InPlaceRespawnState. Ephemeral prompt/cadence state does not. Listener ownership lives
      // in ClientAttachments; the spawner restores every genuinely attached transport for this session id on
      // its own (see spawner.ts), so there is nothing else to carry here.
      const prevState = previous ? captureInPlaceRespawnState(previous) : undefined;
      const policy = this.d.policy?.(userId) ?? { allowedProjectIds: 'all' as const, allowedPaths: () => [] };
      // No in-flight turn can be running here: a send holds serial(send-<id>)→serial(<id>) across the whole
      // prompt() (turnRunner), and this switch runs under the same serial(sessionId) lock — so it only
      // proceeds once any active turn has fully settled and persisted (agent_end → BrainSessionFactory).
      // The respawn then rehydrates that output from SQLite, so no in-flight output is lost.
      this.d.sessions.dispose(sessionId);
      const userCfg = this.d.userSettings?.(userId);
      let live: LiveBrain;
      try {
        live = await this.d.spawn({
          sessionId,
          ownerUserId: userId,
          selection: sel, // the explicit pick wins over the user's saved default
          policy,
          autoCompact: !!userCfg?.autoCompact,
          clientCwd: prevWorkDir,
        });
      } catch (error) {
        // The respawn that would have carried an active goal forward never happened — pause it instead of
        // leaving it `active` with a cancelled timer and no chance left to reschedule.
        this.d.goals.pauseForRespawnFailure(sessionId, error);
        throw error;
      }
      live.interactedAt = Date.now(); // a model switch is a deliberate touch — don't idle-roll it over
      if (prevState) applyInPlaceRespawnState(live, prevState);
      this.d.sessions.set(sessionId, live);
      // The switch respawned the session, so record the change on the FRESH live (the old one is disposed):
      // a visible transcript marker + a one-shot notice so the agent knows its model changed next turn. This
      // publishes a `session-event` on the live stream — every attached client refetches history + status
      // WITHOUT reopening its SSE (unlike a raw `session` event, which would reset the transcript).
      if (previous && previous.model !== live.model) recordSessionEvent(this.d.store, live.sessionId, live, 'model', live.model);
      const projectRoot = gitProjectRoot(policy, prevWorkDir);
      if (projectRoot && sel.provider && sel.model) {
        this.d.setProjectModelPreference?.(userId, projectRoot, { provider: sel.provider, model: sel.model });
      }
      // A bound (explicit-session) switch must not move the active pointer — the two-tier rule.
      if (!session) this.d.sessions.setActive(userId, sessionId);
      // The respawn succeeded: give a still-active goal a driver again (see resumeAfterRespawn).
      this.d.goals.resumeAfterRespawn(userId, sessionId);
      return { model: live.model };
    });
  }

  /** Why `/clear` refuses instead of waiting: every signal below means something is either WRITING this
   *  conversation's history or is about to read it, and the wipe would land underneath it — an agent_end
   *  that persists a run after the DELETE, a compaction summarizing rows that no longer exist, a queued
   *  steer delivered into the fresh session, a child whose result points at a transcript that is gone.
   *  Refusing is the honest outcome: the user stops the turn (Esc) and clears a quiet conversation.
   *
   *  {@link sessionHasWorkInFlight} is the shared fail-closed predicate (running turn, queued messages,
   *  parked question, live/spared children, background jobs, active goal). The two compaction signals are
   *  added on top because a compaction is not a turn: PI reports `isCompacting` once its controller runs,
   *  and `hasActiveNativeCompactionCheck` covers the auth-before-controller gap where a native check is
   *  already in flight while both `isStreaming` and `isCompacting` still read false. An undelivered child
   *  result completes the set — the delivery would otherwise arrive into a cleared context. */
  private clearRefusal(sessionId: string): string | null {
    const live = this.d.sessions.get(sessionId);
    if (live && (live.session.isCompacting || hasActiveNativeCompactionCheck(live.session))) {
      return 'the conversation is compacting — try again once it finishes';
    }
    if (sessionHasWorkInFlight({ store: this.d.store, sessions: this.d.sessions, elicitation: this.d.elicitation }, sessionId)) {
      return 'the conversation is busy — stop the running work before clearing it';
    }
    // Both of these are checked INDEPENDENTLY of the live record, which the shared predicate is not:
    // it answers "no work" for a session with no live entry (there is nothing live to protect), while a
    // cold conversation can still own an armed goal that re-prompts it from a timer and a delivered-to-
    // nobody child result — both of which would land in the freshly cleared context.
    if (this.d.store.getGoal(sessionId)?.status === 'active') {
      return 'a goal is still driving this conversation — pause or clear the goal first';
    }
    if (this.d.store.pendingSubagentResults(sessionId).length > 0) {
      return 'a delegated result is still waiting to be delivered — try again once it lands';
    }
    return null;
  }

  /** Clear ONE conversation's content in place (the `/clear` command): the durable history, the transcript
   *  markers, the card panel and the live PI context are emptied, while the conversation keeps its id,
   *  title, model/provider, work dir and every attached client — so the next message starts from an empty
   *  context without the user having to open a new conversation.
   *
   *  The live half is the in-place respawn every other same-id path uses (switchModel/restart/vision hop):
   *  dispose the PI session and spawn a fresh one under the same id, which rehydrates from the store —
   *  now empty. That is also what resets the session-scoped derived state for free: PI's steering/follow-up
   *  queue, the tool-search handle (re-seeded from an empty history), the compaction coordinators and the
   *  cold-start assessment all belong to the disposed session. Deliberately NOT an in-place respawn in the
   *  {@link InPlaceRespawnState} sense: a cleared context must not inherit `lastTurnMode` /
   *  `orientedForCompaction` / `modeReminderTurns`, whose whole meaning is "the model already read this
   *  earlier in THIS conversation" — after a clear it never did (same reason maybeRollover skips them).
   *
   *  The model is passed EXPLICITLY rather than left to the spawn's own resolution: that path only restores
   *  a conversation's stored pin once it has been spoken in (`lastMessageAt`), which an emptied history no
   *  longer reports, and `/clear` must not quietly move the conversation onto the user's default model.
   *
   *  Locking follows the topology in LiveSessionRegistry EXACTLY as a send does — outer `send-<id>`, then
   *  the bare session id. The outer lock is load-bearing, not belt-and-braces: a send holds it across its
   *  idle-rollover and vision-hop awaits while the inner lock is free and `isStreaming` is still false, so
   *  a clear taking only the inner lock would see a quiet conversation, dispose the live session under
   *  that send, and let it prompt() a disposed session holding the pre-clear context in memory — the
   *  cleared history would go straight back to the provider and be persisted again by its agent_end.
   *  Refuses (never waits) while work is in flight; see {@link clearRefusal}. */
  async clearConversation(userId: number, session?: string): Promise<{ sessionId: string; model: string }> {
    const sessionId = session ? this.ownedUserSession(userId, session) : this.activeSessionId(userId);
    // Checked BEFORE queueing on the locks as well: a running turn holds them for its full duration, and a
    // destructive command must answer "the conversation is busy" now rather than after the turn it was
    // meant to protect has finished.
    const refusal = this.clearRefusal(sessionId);
    if (refusal) throw new Error(refusal);
    return this.serial(sendLockKey(sessionId), () => this.serial(sessionId, async () => {
      // Re-checked under the locks: a child, a goal timer or a parked question can arrive in the window
      // between the pre-check and acquiring them (the same double evaluation stopSession does).
      const blocked = this.clearRefusal(sessionId);
      if (blocked) throw new Error(blocked);
      const previous = this.d.sessions.get(sessionId);
      const clearedCardIds = this.d.cards.forSession(sessionId).map((c) => c.id);
      this.d.store.clearSessionHistory(sessionId);
      this.d.cards.clearSession(sessionId); // evict the write-through cache over the rows just deleted
      const storedModel = this.d.store.getSession(sessionId)?.model ?? '';
      if (!previous) return { sessionId, model: storedModel }; // cold conversation: nothing live to reset
      const prevWorkDir = previous.workDir; // clearing must not move the session cwd
      const userCfg = this.d.userSettings?.(userId);
      const policy = this.d.policy?.(userId) ?? { allowedProjectIds: 'all' as const, allowedPaths: () => [] };
      this.d.sessions.dispose(sessionId);
      // No goal cancel/resume around this respawn, unlike switchModel: an ACTIVE goal is work in flight
      // and was already refused above, so there is no continuation to carry across or to pause on failure.
      // A failed spawn leaves the conversation with no live record, which the next send/ensureLive
      // respawns exactly as it does after any other dispose.
      const live = await this.d.spawn({
        sessionId,
        ownerUserId: userId,
        selection: { provider: previous.providerId, model: previous.model },
        policy,
        thinkingLevel: previous.thinkingLevel ?? undefined,
        autoCompact: !!userCfg?.autoCompact,
        clientCwd: prevWorkDir,
      });
      live.interactedAt = Date.now(); // a clear is a deliberate touch — don't idle-roll it over
      this.d.sessions.set(sessionId, live);
      // Tell attached clients on the FRESH stream to rebuild from the server: `compacted` is the existing
      // "the daemon rewrote this session's stored rows, refetch history" signal (CLI StreamCoordinator and
      // the web dock both handle it), and the refetch now returns an empty transcript. A raw `session`
      // event would be wrong — the id did not change, and the surfaces read it as an idle rollover.
      live.replay.publish({ type: 'compacted' });
      // The card panel is client-side state seeded from the status snapshot, so the rows being gone is not
      // enough: re-emit each cleared card empty, which is the panel's own REMOVE signal (see upsertCard).
      for (const id of clearedCardIds) live.replay.publish({ type: 'card', card: { id, pinned: false } });
      return { sessionId, model: live.model };
    }));
  }

  /** Idle rollover — the ONE chokepoint every owner-chat message funnels through (web, CLI): a
   *  conversation whose last message sits past the cutoff continues as a FRESH session instead —
   *  the provider's prompt cache is long expired, so continuing would drag the whole stale context
   *  back in at full price. A running turn is never cut (a streaming send steers in the turn runner;
   *  one that queued here behind a finishing turn sees a fresh lastMessageAt and stays). An explicitly
   *  reopened conversation counts as fresh interaction (LiveBrain.interactedAt). Subscribers are
   *  carried onto the replacement session so open event streams survive, then told via the
   *  `session` event so their transcript restarts at this message (a bound CLI rebinds to the id the
   *  event carries). Returns the (possibly replaced) live session. */
  async maybeRollover(userId: number, b: LiveBrain, clientCwd?: string): Promise<LiveBrain> {
    // A background delegate can outlive the parent's own prompt. Its durable parent id must stay stable
    // until the child settles, so never archive/replace a conversation that still owns running children.
    //
    // Nor do we cut a conversation a terminal still has OPEN. The cutoff exists to avoid dragging a stale
    // context back in at full price after the prompt cache expired — a fair trade for a conversation nobody
    // is looking at, but not for one the user is sitting in front of: they step away, come back, type, and
    // would find their thread silently replaced by an empty one. An idle CLI conversation therefore stays;
    // the user starts a new one when THEY want one (/new, or simply relaunching). Every other surface —
    // web, Discord, cron — is unaffected and keeps rolling over as before.
    if (b.session.isStreaming || this.d.sessions.hasActiveChildren(b.sessionId)
        || this.d.attachments.hasLiveStableClient(b.sessionId)
        || !rolloverDue({ lastMessageAt: this.d.store.lastMessageAt(b.sessionId), interactedAt: b.interactedAt, now: Date.now() })) return b;
    const oldId = b.sessionId;
    const wasActive = this.activeSessionId(userId) === oldId;
    const freshId = freshUserSessionId(userId);
    // Publish the identity transition to attachment bookkeeping before the first async spawn boundary.
    // A quit POST can race while ensureLive awaits provider/session setup; it must already resolve the
    // old client-visible id to `freshId` rather than concluding that the disposed predecessor is gone.
    // This is also what carries every genuinely attached transport (subscribe + taps) onto the fresh
    // session id — the spawner restores them from ClientAttachments, so nothing else has to.
    this.d.attachments.retarget(oldId, freshId);
    this.d.goals.cancelGoalContinuation(oldId);
    this.d.elicitation.cancelForSession(oldId, 'session stopped');
    this.d.sessions.dispose(oldId);
    try {
      await this.ensureLive(userId, freshId, { clientCwd });
    } catch (error) {
      // The spawn failed: the fresh id never became live, so unwind the identity transition back onto the
      // old id. The old runtime is already gone (its dispose above is real, not undoable), but leaving
      // attachments pointed at the old id means the NEXT ensureLive/send simply respawns it there — instead
      // of the current client staying permanently dark behind a fresh id nothing will ever spawn into (see
      // the sol review finding 6). The active pointer is untouched here on purpose: it only moves below,
      // after a successful respawn, so on failure it is still exactly where it was before this call.
      this.d.attachments.retarget(freshId, oldId);
      throw error;
    }
    const fresh = this.d.sessions.get(freshId);
    if (!fresh) throw new Error('brain not started for user');
    // The pointer follows the rollover only when it pointed at the rolled-over conversation — a bound
    // send on a non-active conversation must not hijack the pointer from another client.
    if (wasActive) this.d.sessions.setActive(userId, freshId);
    // Rollover opens a brand-new EMPTY conversation — deliberately NOT an in-place respawn: it must not
    // carry the old one's prompt/cadence state (lastTurnMode/orientedForCompaction/modeReminderTurns).
    // Doing so would make TurnContextBuilder.modeTemplateFor() emit a sparse mode instruction claiming the
    // full text is already earlier in THIS conversation's history, which is never true for a fresh id.
    fresh.replay.publish({ type: 'session', sessionId: fresh.sessionId });
    return fresh;
  }

  /** Vision fallback (Account → CLI): an image turn on a text-only model hops onto the user's
   *  configured vision model — the session respawns there IN PLACE (same id; history rehydrates from
   *  SQLite) and hops back on the next text-only turn, so the fallback never silently becomes the
   *  permanent model. Never goes through start(): a hop must not move the active pointer. */
  async maybeVisionHop(userId: number, b: LiveBrain, hasImages: boolean, clientCwd?: string): Promise<LiveBrain> {
    const settings = this.d.userSettings?.(userId);
    const hop = decideVisionHop({
      hasImages, onFallback: !!b.visionFallback,
      currentModel: b.model, currentProvider: b.providerId,
      // Same source of truth the model descriptor uses to decide whether to strip images
      // (providers.ts modelEntry): a model the catalog knows reads images keeps its turn.
      currentModelHasVision: !!b.providerId && !!b.model && catalogModelVision(b.providerId, b.model) === true,
      visionModel: settings?.visionModel, visionModelProvider: settings?.visionModelProvider,
    });
    if (hop.action === 'none') return b;
    const hopId = b.sessionId;
    const prevWorkDir = b.workDir; // survive the respawn — the hop must not move the session cwd
    // In-place respawn (same id) — see InPlaceRespawnState. Listener ownership lives in ClientAttachments,
    // so the spawner restores every attached transport for this session id on its own.
    const prevState = captureInPlaceRespawnState(b);
    const returnProfile = hop.action === 'hop'
      ? {
          provider: b.providerId,
          model: b.model,
          thinkingLevel: b.thinkingLevel,
        }
      : b.visionFallbackReturn;
    this.d.goals.cancelGoalContinuation(hopId);
    this.d.elicitation.cancelForSession(hopId, 'session stopped');
    this.d.sessions.dispose(hopId);
    try {
      await this.ensureLive(userId, hopId, {
        clientCwd,
        spawnCwd: prevWorkDir,
        ...(hop.action === 'hop'
          ? { provider: hop.provider, model: hop.model }
          : returnProfile
            ? {
                provider: returnProfile.provider,
                model: returnProfile.model,
                thinkingLevel: returnProfile.thinkingLevel ?? null,
              }
            : {}),
      });
    } catch (error) {
      this.d.goals.pauseForRespawnFailure(hopId, error);
      throw error;
    }
    const fresh = this.d.sessions.get(hopId);
    if (!fresh) throw new Error('brain not started for user');
    applyInPlaceRespawnState(fresh, prevState);
    // Mark the fallback active only if the respawn actually reached the requested vision model (not the
    // configured default because the vision model was unavailable/disallowed) — so the NEXT text turn
    // hops back. Provider matters too: two configured entries can expose the same model id.
    if (hop.action === 'hop') {
      const reachedFallback = fresh.model === hop.model && (!hop.provider || fresh.providerId === hop.provider);
      fresh.visionFallback = reachedFallback;
      if (reachedFallback) fresh.visionFallbackReturn = returnProfile;
    }
    this.d.goals.resumeAfterRespawn(userId, hopId);
    return fresh;
  }

  subscribe(userId: number, listener: (e: BrainEvent) => void, clientId?: string, clientGeneration?: number): () => void {
    const b = this.activeLive(userId);
    if (!b) throw new Error('brain not started for user');
    let detached = false;
    const off = (): void => {
      if (detached) return;
      detached = true;
      this.d.attachments.detachTransport(listener);
      // An idle rollover may have MOVED this listener onto a replacement session (send() carries
      // subscribers over so open streams survive) — and the user may have switched active sessions
      // since, so sweep EVERY live session, not just the original and the currently active one
      // (a listener left on a non-active live would keep receiving events for a dead stream forever).
      for (const [, live] of this.d.sessions.liveEntries()) live.listeners.delete(listener);
      // The source LiveBrain may already have been removed from the registry during rollover; clearing
      // its captured set prevents the carry step from resurrecting a transport stopped mid-spawn.
      b.listeners.delete(listener);
    };
    if (!this.d.attachments.attach(userId, b.sessionId, listener, off, clientId, clientGeneration)) {
      throw new Error('stale client stream');
    }
    b.listeners.add(listener);
    return off;
  }

  /** Follow one of the CALLER'S OWN sessions live, by explicit id — the CLI's bound conversation
   *  stream and the sub-agent drill-in stream. Unlike subscribe() (which follows the active
   *  conversation), a tap targets a fixed session and keeps delivering across respawns. Throws on an
   *  unknown/foreign session. */
  tapSession(userId: number, sessionId: string, listener: (e: BrainEvent) => void, clientId?: string, clientGeneration?: number): () => void {
    const targetSessionId = this.resolveStreamSession(userId, sessionId, clientId, clientGeneration);
    const row = this.d.store.getSession(targetSessionId);
    if (!row || row.user_id !== userId) throw new Error('unknown session');
    const initialLive = this.liveFor(targetSessionId);
    let detached = false;
    const off = (): void => {
      if (detached) return;
      detached = true;
      // detachTransport removes the persistent ClientAttachments-owned record (sessionTaps included), so
      // no later respawn ever re-attaches this listener again — see ClientAttachments.sessionTaps.
      this.d.attachments.detachTransport(listener);
      // An idle rollover may have CARRIED this listener onto a replacement session (send() moves
      // subscribers so open streams survive) — sweep every live user session, then the channel bucket.
      for (const [, live] of this.d.sessions.liveEntries()) live.listeners.delete(listener);
      this.liveFor(targetSessionId)?.listeners.delete(listener);
      initialLive?.listeners.delete(listener);
    };
    if (!this.d.attachments.attach(userId, targetSessionId, listener, off, clientId, clientGeneration)) {
      throw new Error('stale client stream');
    }
    initialLive?.listeners.add(listener); // the session may already be running — attach now
    return off;
  }

  /** Restart a user's live session so changed settings (model override, plugins) apply immediately.
   *  No-op when not running. History survives — it rehydrates from SQLite on the fresh start. Respawns
   *  the SAME conversation in place (never a cwd re-resolution — this is a settings reload, not a
   *  client boot) and carries the previous workDir over without stamping it. */
  /** `reapplyModelPreference` — the caller changed the user's MODEL setting, so the conversation must
   *  drop the model it was pinned to and re-resolve from preference. Every other restart (plugin
   *  reload, personality change) deliberately leaves the pin alone: reloading a plugin is no reason to
   *  move a conversation off the model its user picked. */
  async restart(userId: number, opts: { reapplyModelPreference?: boolean } = {}): Promise<void> {
    const b = this.activeLive(userId);
    if (!b) return;
    const sessionId = b.sessionId;
    // Release a parked AskUserQuestion first, else `settled` waits out its full timeout.
    this.d.elicitation.cancelForSession(sessionId, 'session restarted');
    await this.d.sessions.settled(sessionId); // let an in-flight turn settle before disposing the session
    // The active pointer (or this very session) can move during that await — a settings save racing a
    // conversation switch, or a second concurrent respawn winning the race. Restart only the EXACT
    // instance it captured, verified still registered under sessionId; never re-resolve "which session"
    // through activeLive() or stop() (both would answer against whatever is active/live NOW, which is how
    // a restart could tear down an unrelated conversation — see the sol review finding 1). A session that
    // moved on is not this restart's problem to finish; whatever replaced it owns its own lifecycle.
    if (this.d.sessions.get(sessionId) !== b) return;
    const prevWorkDir = b.workDir; // the restart must not move the session cwd
    // In-place respawn (same id) — see InPlaceRespawnState. Even a settings reload rebuilds PI from durable
    // history, which strips ephemeral orientation and mode framing; only the conversation's last mode fact
    // survives. Listener ownership lives in ClientAttachments; the spawner restores every attached
    // transport on its own.
    const prevState = captureInPlaceRespawnState(b);
    this.d.goals.cancelGoalContinuation(sessionId);
    this.d.sessions.dispose(sessionId);
    try {
      await this.ensureLive(userId, sessionId, { spawnCwd: prevWorkDir, reapplyModelPreference: opts.reapplyModelPreference });
    } catch (error) {
      this.d.goals.pauseForRespawnFailure(sessionId, error);
      throw error;
    }
    const fresh = this.d.sessions.get(sessionId);
    if (fresh) {
      applyInPlaceRespawnState(fresh, prevState);
      // The respawn succeeded: give a still-active goal a driver again (see resumeAfterRespawn).
      this.d.goals.resumeAfterRespawn(userId, sessionId);
    }
  }

  stop(userId: number): void {
    const b = this.activeLive(userId);
    if (b) {
      this.d.goals.cancelGoalContinuation(b.sessionId);
      // A definitive stop has no reschedule coming (unlike a same-id respawn) — flip an active goal to
      // paused so the row stops claiming a driver that no longer exists. reconcileGoal is the same rule
      // start()'s switch-away guard already uses; it only pauses when there is genuinely no timer, which
      // cancelGoalContinuation above just guaranteed.
      this.d.goals.reconcileGoal(b.sessionId, 'interrupted (session stopped)');
      this.d.elicitation.cancelForSession(b.sessionId, 'session stopped');
      this.d.sessions.dispose(b.sessionId);
    }
  }
}
