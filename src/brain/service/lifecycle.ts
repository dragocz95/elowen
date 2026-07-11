import { realpathSync } from 'node:fs';
import type { Policy } from '../../plugins/policy.js';
import type { BrainStore } from '../../store/brainStore.js';
import type { ElicitationRegistry } from '../elicitation.js';
import type { BrainEvent } from '../events.js';
import type { LiveSessionRegistry } from '../session/liveRegistry.js';
import { DEFAULT_AUTO_COMPACT_PCT } from '../session/liveBrain.js';
import type { LiveBrain, SpawnOpts } from '../session/liveBrain.js';
import { rolloverDue } from '../session/idleRollover.js';
import { decideVisionHop } from '../visionFallback.js';
import { defaultUserSessionId, freshUserSessionId, isNonUserSession } from '../sessionId.js';
import type { BrainDeps } from '../brainDeps.js';
import type { ClientAttachments } from './attachments.js';
import type { GoalLoopService } from './goalLoop.js';
import { clientDir } from './workDir.js';

interface LifecycleDeps {
  store: BrainStore;
  /** The shared live-session state (owned by the BrainService facade). */
  sessions: LiveSessionRegistry<LiveBrain>;
  attachments: ClientAttachments;
  elicitation: ElicitationRegistry;
  goals: GoalLoopService;
  /** Session composition (LiveSessionSpawner.spawn) — the single spawn source. */
  spawn(opts: SpawnOpts): Promise<LiveBrain>;
  policy?: (userId: number) => Policy;
  userSettings?: BrainDeps['userSettings'];
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
    if (!row || row.user_id !== userId || isNonUserSession(sessionId)) throw new Error('unknown session');
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

  activeLive(userId: number): LiveBrain | undefined {
    return this.d.sessions.get(this.activeSessionId(userId));
  }

  /** The live record behind a session id, whichever registry bucket it lives in (user sessions are
   *  keyed by session id, channel sessions by channel id). */
  private liveFor(sessionId: string): LiveBrain | undefined {
    return this.d.sessions.get(sessionId)
      ?? (sessionId.startsWith('brain-ch-') ? this.d.sessions.channelGet(sessionId.slice('brain-ch-'.length)) : undefined);
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
    // A bound CLI can be following non-active A while another client has moved the global pointer to B.
    // Its stable binding, not that shared pointer, identifies the driver this switch actually leaves.
    const leavingSessionId = opts?.clientId ? claim?.previousSessionId : prevActive;
    // Switching AWAY from a conversation that's parked on an ask_user_question: release its question so
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
   *  cwd-less. Serialized per conversation: two concurrent spawns would leak one PI session. */
  async ensureLive(userId: number, sessionId: string, o: { provider?: string; model?: string; clientCwd?: string; spawnCwd?: string; explicitResume?: boolean; fast?: boolean; thinkingLevel?: string | null } = {}): Promise<void> {
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
      // Model selection: an explicit start option wins, else the user's saved provider+model override,
      // else the first configured provider's first model. A saved model the user is no longer
      // allowed to run falls back to the server default rather than blocking the brain.
      const userCfg = this.d.userSettings?.(userId);
      let selection: { provider?: string; model?: string } = { provider: o.provider ?? userCfg?.modelProvider, model: o.model ?? userCfg?.model };
      if (!this.d.selectionAllowed(userId, selection)) selection = {};
      const policy = this.d.policy?.(userId) ?? { allowedProjectIds: 'all' as const, allowedPaths: () => [] };
      const live = await this.d.spawn({
        sessionId,
        ownerUserId: userId,
        selection,
        policy,
        // `null` explicitly restores a session whose live reasoning level was unset; omitted keeps the
        // normal Account default. This distinction matters when returning from a temporary vision hop.
        thinkingLevel: o.thinkingLevel === null ? undefined : (o.thinkingLevel ?? userCfg?.thinkingLevel),
        fast: o.fast,
        autoCompact: !!userCfg?.autoCompact,
        autoCompactAtPct: userCfg?.autoCompactAt ?? DEFAULT_AUTO_COMPACT_PCT,
        clientCwd: o.clientCwd ?? o.spawnCwd,
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
    // A parked ask_user_question holds this session's serial lock — release it FIRST (outside the lock)
    // so the switch doesn't wait out the question's timeout.
    this.d.elicitation.cancelForSession(sessionId, 'model switched');
    this.d.goals.cancelGoalContinuation(sessionId);
    return this.serial(sessionId, async () => {
      const previous = this.d.sessions.get(sessionId);
      const prevWorkDir = previous?.workDir; // the switch must not move the session cwd
      const prevFast = previous?.requestProfile.fast;
      this.d.sessions.dispose(sessionId);
      const userCfg = this.d.userSettings?.(userId);
      const live = await this.d.spawn({
        sessionId,
        ownerUserId: userId,
        selection: sel, // the explicit pick wins over the user's saved default
        policy: this.d.policy?.(userId) ?? { allowedProjectIds: 'all' as const, allowedPaths: () => [] },
        fast: prevFast,
        autoCompact: !!userCfg?.autoCompact,
        autoCompactAtPct: userCfg?.autoCompactAt ?? DEFAULT_AUTO_COMPACT_PCT,
        clientCwd: prevWorkDir,
      });
      live.interactedAt = Date.now(); // a model switch is a deliberate touch — don't idle-roll it over
      this.d.sessions.set(sessionId, live);
      // A bound (explicit-session) switch must not move the active pointer — the two-tier rule.
      if (!session) this.d.sessions.setActive(userId, sessionId);
      return { model: live.model };
    });
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
    if (b.session.isStreaming || this.d.sessions.hasActiveChildren(b.sessionId)
        || !rolloverDue({ lastMessageAt: this.d.store.lastMessageAt(b.sessionId), interactedAt: b.interactedAt, now: Date.now() })) return b;
    const carried = b.listeners;
    const oldId = b.sessionId;
    const wasActive = this.activeSessionId(userId) === oldId;
    const freshId = freshUserSessionId(userId);
    // Publish the identity transition to attachment bookkeeping before the first async spawn boundary.
    // A quit POST can race while ensureLive awaits provider/session setup; it must already resolve the
    // old client-visible id to `freshId` rather than concluding that the disposed predecessor is gone.
    this.d.attachments.retarget(oldId, freshId);
    this.d.goals.cancelGoalContinuation(oldId);
    this.d.elicitation.cancelForSession(oldId, 'session stopped');
    this.d.sessions.dispose(oldId);
    await this.ensureLive(userId, freshId, { clientCwd });
    const fresh = this.d.sessions.get(freshId);
    if (!fresh) throw new Error('brain not started for user');
    // The pointer follows the rollover only when it pointed at the rolled-over conversation — a bound
    // send on a non-active conversation must not hijack the pointer from another client.
    if (wasActive) this.d.sessions.setActive(userId, freshId);
    // Attached listener sets were re-keyed before spawn so both the spawner and a racing stop request see
    // the replacement identity. Carry the raw live listeners as well (non-client internal listeners).
    for (const l of carried) fresh.listeners.add(l);
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
      visionModel: settings?.visionModel, visionModelProvider: settings?.visionModelProvider,
    });
    if (hop.action === 'none') return b;
    const hopId = b.sessionId;
    const prevWorkDir = b.workDir; // survive the respawn — the hop must not move the session cwd
    const listeners = b.listeners; // direct web subscribers are not sessionTaps; carry them explicitly
    const returnProfile = hop.action === 'hop'
      ? {
          provider: b.providerId,
          model: b.model,
          thinkingLevel: b.thinkingLevel,
          fast: b.requestProfile.fast,
        }
      : b.visionFallbackReturn;
    this.d.goals.cancelGoalContinuation(hopId);
    this.d.elicitation.cancelForSession(hopId, 'session stopped');
    this.d.sessions.dispose(hopId);
    await this.ensureLive(userId, hopId, {
      clientCwd,
      spawnCwd: prevWorkDir,
      // Fast belongs to the original conversation profile. Never send priority-service metadata to a
      // temporary fallback (which may be non-OAuth); restore the exact prior value on hop-back.
      fast: hop.action === 'hop' ? false : returnProfile?.fast,
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
    const fresh = this.d.sessions.get(hopId);
    if (!fresh) throw new Error('brain not started for user');
    for (const listener of listeners) fresh.listeners.add(listener);
    // Mark the fallback active only if the respawn actually reached the requested vision model (not the
    // configured default because the vision model was unavailable/disallowed) — so the NEXT text turn
    // hops back. Provider matters too: two configured entries can expose the same model id.
    if (hop.action === 'hop') {
      const reachedFallback = fresh.model === hop.model && (!hop.provider || fresh.providerId === hop.provider);
      fresh.visionFallback = reachedFallback;
      if (reachedFallback) fresh.visionFallbackReturn = returnProfile;
    }
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
    const { sessionTaps } = this.d.attachments;
    const initialLive = this.liveFor(targetSessionId);
    let detached = false;
    const off = (): void => {
      if (detached) return;
      detached = true;
      this.d.attachments.detachTransport(listener);
      // Rollover can re-key (or merge) the original tap set, so remove from every key rather than the
      // captured pre-rollover id. This also avoids leaving an empty replacement tap set behind.
      for (const [id, set] of sessionTaps) {
        set.delete(listener);
        if (set.size === 0) sessionTaps.delete(id);
      }
      // An idle rollover may have CARRIED this listener onto a replacement session (send() moves
      // subscribers so open streams survive) — sweep every live user session, then the channel bucket.
      for (const [, live] of this.d.sessions.liveEntries()) live.listeners.delete(listener);
      this.liveFor(targetSessionId)?.listeners.delete(listener);
      initialLive?.listeners.delete(listener);
    };
    if (!this.d.attachments.attach(userId, targetSessionId, listener, off, clientId, clientGeneration)) {
      throw new Error('stale client stream');
    }
    let taps = sessionTaps.get(targetSessionId);
    if (!taps) { taps = new Set(); sessionTaps.set(targetSessionId, taps); }
    taps.add(listener);
    initialLive?.listeners.add(listener); // the session may already be running — attach now
    return off;
  }

  /** Restart a user's live session so changed settings (model override, plugins) apply immediately.
   *  No-op when not running. History survives — it rehydrates from SQLite on the fresh start. Respawns
   *  the SAME conversation in place (never a cwd re-resolution — this is a settings reload, not a
   *  client boot) and carries the previous workDir over without stamping it. */
  async restart(userId: number): Promise<void> {
    const b = this.activeLive(userId);
    if (!b) return;
    const sessionId = b.sessionId;
    // Release a parked ask_user_question first, else `settled` waits out its full timeout.
    this.d.elicitation.cancelForSession(sessionId, 'session restarted');
    await this.d.sessions.settled(sessionId); // let an in-flight turn settle before disposing the session
    const prevWorkDir = b.workDir; // the restart must not move the session cwd
    const prevFast = b.requestProfile.fast;
    this.stop(userId);
    await this.ensureLive(userId, sessionId, { spawnCwd: prevWorkDir, fast: prevFast });
  }

  stop(userId: number): void {
    const b = this.activeLive(userId);
    if (b) { this.d.goals.cancelGoalContinuation(b.sessionId); this.d.elicitation.cancelForSession(b.sessionId, 'session stopped'); this.d.sessions.dispose(b.sessionId); }
  }
}
