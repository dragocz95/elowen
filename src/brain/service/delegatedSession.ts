import type { BrainStore, RecoverableRun } from '../../store/brainStore.js';
import { syntheticRestartResultId } from '../../store/brainStore.js';
import { settlePartialTurn, outstandingToolCalls } from '../persistence.js';
import { deniedToolsForUser } from '../brainDeps.js';
import type { BrainDeps } from '../brainDeps.js';
import type { ChannelSessionService } from '../channels.js';
import type { DelegatedExecutionScope } from '../delegatedScope.js';
import { delegatedToolPolicy, scopeExceedsCurrentAccess } from '../delegatedScope.js';
import type { BrainEvent } from '../events.js';
import type { IdentityResolver } from '../identity.js';
import { extractText } from '../messageView.js';
import type { BrainModelSelection } from '../providers.js';
import type { LiveBrain } from '../session/liveBrain.js';
import type { LiveSessionRegistry } from '../session/liveRegistry.js';
import { channelIdOf, isSubagentSession } from '../sessionId.js';
import { terminalizeWorkflow } from '../workflowRuns.js';
import type { DelegatedContinueResult, SubagentProgressEvent } from '../../plugins/api.js';
import { logger } from '../../shared/logger.js';

/** Parse a `provider/model` spec into a brain model selection. Splits on the FIRST slash only — model
 *  ids themselves may contain slashes (e.g. `ai-coresynth-io/deepseek/deepseek-v4-flash`), so a naive
 *  `split('/')` would carve the model id in half. A bare id without a slash passes through as a model
 *  with no provider, exactly like the stored-row form in sendDelegated. */
function modelSelectionFromSpec(spec: string): BrainModelSelection {
  const slash = spec.indexOf('/');
  if (slash > 0) return { provider: spec.slice(0, slash), model: spec.slice(slash + 1) };
  return { model: spec };
}

/** The BrainEvent members whose live fields actually feed a delegated child's progress row: the child's
 *  session id, tool starts, and step/idle token usage. The host narrows every child event onto the plugin
 *  contract ({@link SubagentProgressEvent}) before invoking the delegating plugin's callback, so a
 *  BrainEvent change must fail HERE at compile time instead of silently widening or starving what the
 *  plugin receives. The pin below asserts the source members still fit the declared shape (catches a
 *  field type change) AND still carry every declared key (catches a field removal). */
type SubagentProgressSource = Extract<BrainEvent, { type: 'session' | 'tool' | 'step' | 'idle' }>;
type SubagentProgressKeys = 'type' | 'name' | 'detail' | 'sessionId' | 'usage';
type SourceKeysOf<T> = T extends T ? keyof T : never;
const subagentProgressContract: (SubagentProgressSource extends SubagentProgressEvent ? true : never)
  & (SubagentProgressKeys extends SourceKeysOf<SubagentProgressSource> ? true : never) = true;
void subagentProgressContract;

/** Narrow a child's BrainEvent onto the declared progress shape the plugin's callback expects. The child's
 *  full event stream reaches the delegating conversation, but the contract promises only
 *  type/name/detail/sessionId/usage.totalTokens — forwarding the raw event would leak fields the contract
 *  never declared, and reading the fields explicitly is what makes a future BrainEvent change fail the
 *  typecheck instead of silently changing what the plugin observes. */
function narrowSubagentProgress(e: BrainEvent): SubagentProgressEvent {
  return {
    type: e.type,
    ...('name' in e && e.name !== undefined ? { name: e.name } : {}),
    ...('detail' in e && e.detail !== undefined ? { detail: e.detail } : {}),
    ...('sessionId' in e && e.sessionId !== undefined ? { sessionId: e.sessionId } : {}),
    ...('usage' in e && e.usage !== undefined ? { usage: { totalTokens: e.usage.totalTokens } } : {}),
  };
}

/** How long a boot's recovery claim holds a run before ANOTHER booting instance may steal it (the lease
 *  in the compare-and-swap). Only matters for a rare concurrent recovery; a normal restart claims a
 *  previous boot's run immediately regardless, because its lease is never set while it runs. */
const RECOVERY_LEASE_MS = 5 * 60_000;
/** A run whose recovery keeps failing (crash loop) is given up as an error after this many attempts, so a
 *  poison transcript cannot respawn forever. attempt is bumped on each claim. */
const MAX_RECOVERY_ATTEMPTS = 3;
/** The follow-up appended to a rehydrated child transcript to finish an interrupted delegation. Kept as a
 *  suffix so the already-sent prefix — and its prompt cache — is untouched. */
const RECOVERY_INSTRUCTION =
  'The daemon restarted and interrupted you mid-task. Your transcript above is intact up to your last '
  + 'completed step. Continue from there, finish the task you were originally given, and give your final '
  + 'answer as usual.';

interface DelegatedSessionDeps {
  store: BrainStore;
  /** The shared live-session state (owned by the BrainService facade). */
  sessions: LiveSessionRegistry<LiveBrain>;
  /** Runs the child's turn (send) and its targeted teardown (abort) — the same channel service platform
   *  turns use, so a delegate rides the exact path a channel message does. */
  channelService: ChannelSessionService;
  identity: IdentityResolver;
  users: BrainDeps['users'];
  policyForProjects?: BrainDeps['policyForProjects'];
  /** Ask the sub-agent runner to drop its live record for a child before this process rehydrates it.
   *  Every send below runs the turn HERE, so a record still held over there would leave one session live
   *  in two processes at once. Absent (no runner) ⇒ there is nothing to release. */
  releaseRemote?: (channelId: string) => Promise<{ busy: boolean }>;
  /** Steer a parent's follow-up into a child turn RUNNING in the sub-agent runner — the cross-process
   *  half of continueSubagent's mid-turn delivery. Absent (no runner) ⇒ no remote turn can exist. */
  steerRemote?: (channelId: string, text: string) => Promise<{ outcome: 'delivered' | 'idle' | 'aborted' }>;
}

/** The sub-agent delegation half of the brain facade: the durable boot reconcile of restart-zombie
 *  delegation rows, the ownership-guarded drill-in paths (read/continue/stop a direct child), and the
 *  single delegated-turn dispatch shared by owner drill-ins and hidden result delivery. Everything here
 *  is keyed on the parent session the caller resolves — a plugin or route can never address another
 *  conversation's children. */
export class DelegatedSessionService {
  constructor(private d: DelegatedSessionDeps) {}

  /** Runs this boot CLAIMED for recovery in {@link reconcileDelegationsOnBoot} (synchronous), to respawn
   *  asynchronously in {@link runDelegationRecovery} once the platforms are up. Held on the instance so the
   *  two boot phases stay ordered: claim before any client attaches, respawn only after channelService can
   *  actually run a turn. */
  private pendingRecovery: RecoverableRun[] = [];

  /** Boot phase 1 (SYNCHRONOUS, before startPlatforms): atomically CLAIM every restart-orphaned delegation
   *  for this boot and stash it for phase 2. The compare-and-swap in claimRecoverableRuns is what makes the
   *  blanket "everything running is a zombie" rule safe even with the sub-agent runner: a row owned by a
   *  PREVIOUS boot is the orphan, a row this boot owns is live. Workflows keep the old treatment — a
   *  WorkflowStart BLOCKS, so a restart killed its whole turn and nobody waits on a result; the row only has
   *  to stop claiming the DAG runs. Nothing is respawned here: the actual recovery turns need the platforms
   *  up and must not run before any client can attach, so they are deferred to runDelegationRecovery. */
  reconcileDelegationsOnBoot(): void {
    // Retire results addressed to a sub-agent that has already finished. Delivery needs a parent TURN to
    // acknowledge it, and a terminal sub-agent is never prompted again, so such a row stays pending for
    // good — and the shutdown drain waits on that count globally, which is how one dead row from 18 Aug
    // made every restart afterwards burn the full ten-minute budget. Swept BEFORE the claim below, so a
    // run about to be respawned still counts as live and keeps its results.
    const orphaned = this.d.store.discardOrphanedDeliveries();
    if (orphaned > 0) {
      logger('brain').info(`boot: retired ${orphaned} delegated result(s) whose parent sub-agent had already finished`);
    }
    this.pendingRecovery = this.d.store.claimRecoverableRuns(RECOVERY_LEASE_MS);
    if (this.pendingRecovery.length > 0) {
      logger('brain').info(`boot recovery claimed ${this.pendingRecovery.length} interrupted delegation(s) for respawn`);
    }
    for (const sessionId of this.d.store.runningDelegationParentSessionIds()) {
      for (const run of this.d.store.getWorkflowRuns(sessionId)) {
        if (run.status !== 'running') continue;
        this.d.store.upsertWorkflowRun(sessionId, terminalizeWorkflow(run));
      }
    }
  }

  /** Boot phase 2 (ASYNCHRONOUS, after startPlatforms): respawn each claimed delegation to finish where it
   *  was interrupted, or park it as recovery_required when replay is not safe. Runs the children serially
   *  so a fleet of interrupted delegations does not stampede the freshly booted daemon. An unexpected turn
   *  failure is parked with a durable parent notice instead of leaving a current-boot `recovering` claim with
   *  no worker until another daemon restart happens to retry it. */
  async runDelegationRecovery(): Promise<void> {
    const claimed = this.pendingRecovery;
    this.pendingRecovery = [];
    for (const run of claimed) {
      try { await this.recoverOne(run); }
      catch (e) {
        const message = (e instanceof Error ? e.message : String(e)).slice(0, 2_000);
        logger('brain').error(`boot recovery of ${run.childSessionId} failed: ${message}`);
        const reason = `automatic restart recovery failed: ${message}`;
        const parked = this.d.store.markRecoveryRequired(run.parentSessionId, run.toolCallId, reason, {
          id: syntheticRestartResultId(run.parentSessionId, run.toolCallId),
          toolCallId: run.toolCallId,
          sessionId: run.childSessionId,
          status: 'error',
          task: run.state.task,
          tools: run.state.tools,
          seconds: run.state.seconds,
          ...(run.state.tokens !== undefined ? { tokens: run.state.tokens } : {}),
          ...(run.state.model !== undefined ? { model: run.state.model } : {}),
          error: `${reason}. Continue the sub-agent ${run.childSessionId} with DelegateContinue after checking whether its last step completed.`,
        });
        if (!parked) logger('brain').error(`boot recovery of ${run.childSessionId} could not park its stale claim`);
      }
    }
  }

  /** Recover ONE claimed delegation. Gives up as an error past the attempt cap; parks as recovery_required
   *  when the interrupted transcript ends on an UNANSWERED tool call (replaying it might repeat a side
   *  effect the parent must decide on); otherwise trims the partial tail and respawns the child to finish,
   *  then completes the run atomically — enqueuing the result even for a foreground delegation, whose
   *  blocking parent turn did not survive the restart. */
  private async recoverOne(run: RecoverableRun): Promise<void> {
    const { parentSessionId, toolCallId, childSessionId, attempt, state } = run;
    const base = {
      id: syntheticRestartResultId(parentSessionId, toolCallId), toolCallId, sessionId: childSessionId,
      task: state.task, tools: state.tools, seconds: state.seconds,
      ...(state.tokens !== undefined ? { tokens: state.tokens } : {}),
      ...(state.model !== undefined ? { model: state.model } : {}),
    };
    if (attempt > MAX_RECOVERY_ATTEMPTS) {
      this.d.store.completeRecoveredRun(parentSessionId, toolCallId, {
        ...base, status: 'error', error: 'sub-agent could not be recovered after repeated daemon restarts',
      });
      return;
    }
    // Classify the crash-interrupted tail BEFORE trimming it. An unanswered tool call in the discarded
    // suffix means a step STARTED whose effect is unknown — replaying the turn could repeat it, so the
    // parent decides via DelegateContinue instead of the daemon guessing.
    const pending = this.d.store.pendingMessages(childSessionId);
    const outstanding = outstandingToolCalls(pending.map((row) => row.content));
    if (outstanding.length > 0) {
      const names = outstanding.map((o) => o.name).join(', ');
      const reason = `interrupted by a daemon restart with unanswered tool call(s): ${names}`;
      this.d.store.markRecoveryRequired(parentSessionId, toolCallId, reason, {
        ...base, status: 'error',
        error: `${reason}. Not auto-recovered because replaying the turn could repeat a side effect. `
          + `To resume, continue the sub-agent ${childSessionId} with DelegateContinue — be aware the interrupted step may run again.`,
      });
      return;
    }
    // Safe to replay: drop the partial tail so the transcript ends clean, then respawn the child with a
    // suffix instruction to finish. The child owns this session id, so sendDelegated resolves its scope.
    settlePartialTurn(this.d.store, childSessionId);
    const owner = this.d.store.getSession(childSessionId);
    if (!owner) {
      this.d.store.completeRecoveredRun(parentSessionId, toolCallId, {
        ...base, status: 'error', error: 'sub-agent session vanished before it could be recovered',
      });
      return;
    }
    const answer = await this.sendDelegated(owner.user_id, childSessionId, RECOVERY_INSTRUCTION);
    // The respawn was a continuation turn of the CHILD, which never edits its own run row (that row belongs
    // to the parent), so the lifecycle is still `recovering` and completeRecoveredRun terminalizes it and
    // enqueues the answer in one transaction.
    this.d.store.completeRecoveredRun(parentSessionId, toolCallId, { ...base, status: 'done', result: answer });
  }

  /** Synchronous route preflight for `/brain/subagent/send`: a legacy child with no immutable scope
   *  must return 409 now, not be silently swallowed by the route's detached promise. */
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
    await this.sendDelegated(userId, sessionId, text);
  }

  /** A delegating turn reading the final stored reply of one of its own sub-agents. The durable parent
   *  relation and sub-agent id family are the confidentiality boundary; requiring a resolvable delegated
   *  scope also rejects legacy/corrupt children exactly like continuation does.
   *
   *  `scopeExceedsCurrentAccess` deliberately does not apply here: reading stored text executes no child
   *  tools and cannot revive its captured permissions. Applying a write-time execution check would only
   *  make an already-authorized parent lose access to its own durable result after its tool scope narrows.
   *
   *  Deliberately NOT `lastAssistantText` (which is `lastAssistant` — literally the last row). A follow-up
   *  attempt on this child that later errored (a bad model route, a dropped connection) appends its own
   *  empty-text assistant row AFTER the real answer, and the shared helper would then report the child as
   *  having "no final text" even though it plainly does — one row further back. Scanning backward for the
   *  last NON-EMPTY assistant text is what "the sub-agent's answer" actually means here. */
  readSubagent(parentSessionId: string, childSessionId: string): string {
    const row = this.d.store.getSession(childSessionId);
    if (!row || row.parent_session_id !== parentSessionId || !isSubagentSession(childSessionId)) {
      throw new Error('unknown sub-agent for this conversation — use DelegateList to choose an id from this conversation');
    }
    if (this.d.sessions.isActiveChild(childSessionId)) {
      throw new Error('that sub-agent is still running — wait for it to finish before reading its final assistant text');
    }
    const scope = this.d.store.delegatedAccessFor(childSessionId);
    if (!scope) throw new Error('delegated access unavailable');
    const messages = this.d.store.getMessages(childSessionId);
    let text = '';
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]!.role !== 'assistant') continue;
      try {
        const candidate = extractText(JSON.parse(messages[i]!.content));
        if (candidate) { text = candidate; break; }
      } catch { /* malformed row — keep scanning further back */ }
    }
    if (!text) {
      throw new Error('that sub-agent has not produced final assistant text yet — wait for it to finish, then try DelegateRead again; if it finished empty, use DelegateContinue to ask for a conclusion');
    }
    return text;
  }

  /** Stop a runaway or no-longer-needed DIRECT sub-agent — the targeted counterpart of the whole-tree
   *  teardown `/stop` already does. Same ownership guard as {@link readSubagent}: the child must belong to
   *  THIS conversation, so a sibling's or another account's sub-agent is not addressable, and stopping one
   *  never reaches past it — `ChannelSessionService.abort` recurses into whatever that child itself
   *  delegated, exactly like a platform `/stop`, so the whole stuck branch (a foreground-blocked middle
   *  agent together with the grandchild it is blocked on) comes down together. `{stopped: false}` for a
   *  child that already finished (or never started) is not an error — there is simply nothing to stop. */
  async stopSubagent(parentSessionId: string, childSessionId: string): Promise<{ stopped: boolean }> {
    const row = this.d.store.getSession(childSessionId);
    if (!row || row.parent_session_id !== parentSessionId || !isSubagentSession(childSessionId)) {
      throw new Error('unknown sub-agent for this conversation — use DelegateList to choose an id from this conversation');
    }
    if (!this.d.sessions.isActiveChild(childSessionId)) return { stopped: false };
    await this.d.channelService.abort(channelIdOf(childSessionId));
    return { stopped: true };
  }

  /** A delegating TURN continuing one of its own sub-agents — the agent-facing counterpart of the owner's
   *  drill-in `sendToSubagent`, which streams to a human instead.
   *
   *  An IDLE child picks its transcript back up (rehydrated from SQLite) and answers the follow-up as its
   *  own turn; the reply comes back as `{status:'reply'}`. A child whose turn is IN FLIGHT is no longer
   *  refused: the message is STEERED into the running turn — the same primitive a user steering their
   *  agent (and the owner drill-in) already ride, so it appends to the transcript's END and never touches
   *  already-sent prefix (prompt-cache safe). The call resolves `{status:'steered'}` only once the message
   *  provably reached the child's context (see ChannelSessionService.steerDelegatedTurn); a steer that the
   *  ending turn never drained is removed and delivered as a fresh idle turn instead, so it can neither
   *  vanish silently nor double-deliver. Both agents drive one transcript, but only through PI's own
   *  steering queue inside the child's turn — never as a second concurrent turn.
   *
   *  Guards, in order, and each of them is the point:
   *  - `parentSessionId` comes from the HOST's own turn scope, never from the calling plugin, and the
   *    child must name exactly it. That is what keeps a conversation inside its own delegation tree —
   *    a sibling conversation's (or another account's) child is simply not addressable.
   *  - The persisted scope may not exceed what this conversation holds NOW (see
   *    scopeExceedsCurrentAccess) — checked BEFORE any delivery, so a parent whose access has narrowed
   *    cannot inject instructions into a child running wider than it. An idle continuation is then
   *    narrowed further by the caller's current denies.
   *  - A `model` switch is refused while the child is mid-turn: a running turn cannot change model, and
   *    silently dropping the switch would lie about what the child runs on.
   *  - A child that is active but not steerable anywhere (its turn is queued for a runner slot, or it sits
   *    between turns collecting background work) is refused with a retry hint: running a fresh turn in
   *    that window could put one transcript live in two processes at once. */
  async continueSubagent(
    parentSessionId: string,
    childSessionId: string,
    text: string,
    access: Parameters<typeof scopeExceedsCurrentAccess>[1],
    onEvent?: (e: SubagentProgressEvent) => void,
    model?: string,
  ): Promise<DelegatedContinueResult> {
    const row = this.d.store.getSession(childSessionId);
    if (!row || row.parent_session_id !== parentSessionId || !isSubagentSession(childSessionId)) {
      throw new Error('unknown sub-agent for this conversation');
    }
    const scope = this.d.store.delegatedAccessFor(childSessionId);
    if (!scope) throw new Error('delegated access unavailable');
    const exceeds = scopeExceedsCurrentAccess(scope, access);
    if (exceeds) throw new Error(`cannot continue that sub-agent: ${exceeds}`);
    if (this.d.sessions.isActiveChild(childSessionId)) {
      if (model) {
        throw new Error('that sub-agent has a turn in flight, and a running turn cannot switch model — retry without `model`, or wait for it to finish');
      }
      const channelId = channelIdOf(childSessionId);
      // The turn body lives either HERE or in the sub-agent runner — try both homes. Each steer resolves
      // only once the message is confirmed in the child's context (or provably not deliverable there).
      if (await this.d.channelService.steerDelegatedTurn(channelId, text) === 'delivered') {
        return { status: 'steered' };
      }
      const remote = await this.d.steerRemote?.(channelId, text) ?? { outcome: 'idle' as const };
      if (remote.outcome === 'delivered') return { status: 'steered' };
      if (remote.outcome === 'aborted') throw new Error('delegation aborted');
      // Still registered as active with no steerable turn anywhere: the turn is queued for a runner slot,
      // starting up, or the child sits between turns (collecting background work). A fresh turn now could
      // race the pending one — refuse, retryably, exactly like the old blanket refusal did.
      if (this.d.sessions.isActiveChild(childSessionId)) {
        throw new Error('that sub-agent is busy between model steps (starting up or collecting background work) and cannot take a steered message right now — try again in a moment');
      }
      // The delegation ended while we looked: the child is idle now, so fall through to a normal turn.
    }
    const reply = await this.sendDelegated(row.user_id, childSessionId, text, {
      extraDeny: access.toolPolicy?.deny ?? [],
      // The plugin's callback contract is the narrow progress shape, while the child's stream is the full
      // BrainEvent set — narrow every event at this boundary so the value matches the declared contract.
      ...(onEvent ? { onEvent: (e: BrainEvent) => onEvent(narrowSubagentProgress(e)) } : {}),
      ...(model ? { model } : {}),
    });
    return { status: 'reply', reply };
  }

  /** Resolve the durable, immutable scope for an owner drill-in. Kept synchronous so the HTTP route can
   *  reject a legacy/corrupt child before it fire-and-forgets the actual long-running continuation. */
  private delegatedContinuation(userId: number, sessionId: string): {
    // `model`/`provider` are carried because a continuation has to resume on the model the sub-agent
    // actually ran on — see sendDelegated, where omitting them silently fell back to the account default.
    row: { id: string; user_id: number; parent_session_id: string | null; model: string; provider: string };
    parentSessionId: string;
    scope: DelegatedExecutionScope;
  } {
    const row = this.d.store.getSession(sessionId);
    if (!row || row.user_id !== userId) throw new Error('unknown session');
    if (!isSubagentSession(sessionId)) throw new Error('not a sub-agent session');
    const parentSessionId = row.parent_session_id;
    if (!parentSessionId) throw new Error('invalid parent session');
    const parent = this.d.store.getSession(parentSessionId);
    if (!parent || parent.user_id !== userId) throw new Error('invalid parent session');
    const scope = this.d.store.delegatedAccessFor(sessionId);
    if (!scope) throw new Error('delegated access unavailable');
    return { row, parentSessionId, scope };
  }

  /** The single delegated-turn dispatch, shared by the owner's drill-in continuations (`sendToSubagent`)
   *  and hidden host system turns (durable sub-agent result delivery, via `internalSystem`). Resolves the
   *  child's immutable execution scope, rebuilds its captured policy + current account deny-list, and drives
   *  channelService.send with `ownerSteer`. `idleRolloverMs` is pinned to Infinity: a drill-in or a
   *  result-delivery turn must NEVER roll the delegate's transcript over (archiving it under a fresh id out
   *  from under the still-owned child) — the child's own delegation owns that transcript. */
  // `async` matters even though the body has no await of its own: delegatedContinuation() throws
  // SYNCHRONOUSLY (unknown session, bad parent, missing scope). Without it those escape a function
  // declaring Promise<string>, so a caller using the `void fn().catch(...)` style — as the HTTP route for
  // sendToSubagent does — would take an uncaught throw instead of the rejection it guards against.
  async sendDelegated(
    userId: number, sessionId: string, content: string,
    opts?: {
      internalSystem?: { customType: string; resultId: string };
      /** Additional tool denies from the CALLING turn, layered on the account's own. Only ever narrows;
       *  the captured allow-list stays authoritative (see ChannelSessionService.delegatedExecution). */
      extraDeny?: string[];
      /** Explicit `provider/model` override for this continuation (from the tool's `model` argument).
       *  Takes precedence over the model stored on the child's session row — see the send call below. */
      model?: string;
      onEvent?: (e: BrainEvent) => void;
    },
  ): Promise<string> {
    const { row, parentSessionId, scope } = this.delegatedContinuation(userId, sessionId);
    // The child may be living in the sub-agent runner. Reclaim it before rehydrating it here — and refuse
    // outright while it is still WORKING there, because steering a turn this process cannot see would run
    // two live sessions on one transcript. (`continueSubagent` already refuses a running child through
    // the registry; this covers the owner's drill-in, which deliberately steers instead of refusing.)
    // Guarded rather than `await this.d.releaseRemote?.(…)`: without a runner there is nothing to wait
    // for, and an await here would still push the send below past a microtask — this path reaches
    // channelService.send synchronously by design.
    const release = this.d.releaseRemote;
    if (release) {
      const { busy } = await release(channelIdOf(sessionId));
      if (busy) throw new Error('that sub-agent is running in the sub-agent runner — wait for it to finish before sending it more');
    }
    const policy = scope.admin
      ? { allowedProjectIds: 'all' as const, allowedPaths: () => [] }
      : this.d.policyForProjects?.(scope.projectIds)
        ?? { allowedProjectIds: new Set(scope.projectIds), allowedPaths: () => [] };
    const deniedTools = [...deniedToolsForUser(this.d, userId), ...(opts?.extraDeny ?? [])];
    return this.d.channelService.send({
      channelId: channelIdOf(sessionId),
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
      identity: this.d.identity.forDelegatedTurn(scope, row.user_id),
      // The child's OWN model, read back from its session row. Without this the continuation passed no
      // selection at all, and a child whose channel had since been evicted respawned on whatever
      // resolveBrainModelRoute picks from an EMPTY selection: the first configured provider's first
      // model (providers.ts:342-346). That is list order, not anybody's default — in practice it meant a
      // sub-agent delegated to kimi-coding/k3 came back as ai-coresynth-io/gpt-image-2, an image model
      // that cannot hold a conversation at all. The respawn then WROTE that over the session row, so the
      // original model was lost and a second continuation could not recover it either. A legacy row with
      // no recorded model still falls through to the old behaviour, which is all that is left for it.
      // An explicit `model` from the caller overrides the stored selection: the recorded model may have
      // become unavailable since the child last ran, or the user consciously wants to switch. Without one
      // the stored model stays authoritative — it is what the sub-agent originally ran on.
      ...(opts?.model
        ? { model: modelSelectionFromSpec(opts.model) }
        : row.model ? { model: { model: row.model, ...(row.provider ? { provider: row.provider } : {}) } } : {}),
      ownerSteer: true,
      idleRolloverMs: Number.POSITIVE_INFINITY,
      ...(opts?.internalSystem ? { internalSystem: opts.internalSystem } : {}),
      ...(opts?.onEvent ? { onEvent: opts.onEvent } : {}),
    }, content);
  }
}
