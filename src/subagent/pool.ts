/** THE SUB-AGENT RUNNER POOL: how many runner processes exist, which one a turn runs on, and what
 *  happens to a turn that cannot be placed yet.
 *
 *  ADMISSION SITS HERE, below both spawn routes, and nowhere else. The Delegate tool caps its own
 *  background jobs, but a workflow node does NOT share that cap — `tick()` in plugins/subagent/lib/
 *  workflow.mjs launches every ready node in one event-loop turn — so a cap in either caller leaves the
 *  other wide open. Both reach the runner through exactly one seam, SubagentDispatch → this pool, so the
 *  gate belongs at that seam.
 *
 *  It is PLACEMENT, not a concurrency cap. A turn that does not fit QUEUES and runs when room appears; it
 *  is never refused, because time-sharing a busy pool is the intended behaviour and a refusal would turn
 *  "slow" into "broken". The queue is fair across delegating parents (see FairQueue), so one large
 *  workflow cannot starve an unrelated delegation.
 *
 *  WHY GROWTH AND SHRINK CANNOT CHASE EACH OTHER (the anti-flapping argument, in full):
 *
 *   1. The two predicates are DISJOINT BY CONSTRUCTION. `isSaturated` requires `activeTurns >= 1` on
 *      both of its arms — a runner with no work is never saturated, whatever its event loop reports.
 *      `reapable` requires `activeTurns === 0` AND no routed session AND no activity for IDLE_REAP_MS.
 *      No runner can satisfy both at any instant.
 *   2. Therefore the two DECISIONS are mutually exclusive. Growth requires EVERY live runner to be
 *      saturated, so at the moment growth fires not one runner is reapable. Reaping requires some runner
 *      to be reapable, so at that moment not every runner is saturated and growth is blocked. There is no
 *      state in which the pool would both spawn and reap.
 *   3. A grow → reap → grow CYCLE is impossible on any short timescale. A freshly spawned runner is
 *      immediately the least loaded, so the queued turns that caused the growth are placed on it; for it
 *      to be reaped instead, every one of those turns would have to finish AND no new one arrive for a
 *      full IDLE_REAP_MS (120 s). Growing again then needs pressure, full saturation and a
 *      GROWTH_COOLDOWN_MS (15 s) gap. So the tightest possible oscillation is bounded below by two
 *      minutes of genuine idleness per cycle — which is not flapping, it is the pool correctly tracking
 *      a workload that stops for two minutes at a time.
 *   4. Neither decision reads a value the other writes. Growth reads saturation (turn counts + heartbeat
 *      streaks); reaping reads idleness (turn counts + a monotonic clock). Spawning does not make any
 *      existing runner look idle, and reaping does not make any survivor look saturated — the pool's own
 *      action can never be the evidence for its opposite. */
import { logger } from '../shared/logger.js';
import type { BrainEvent } from '../brain/events.js';
import type { BrainStreamSnapshot } from '../brain/session/liveEventReplay.js';
import { channelIdOf } from '../brain/sessionId.js';
import { SubagentRunnerUnavailable, type DelegatedTurnRequest, type DelegatedTurnRunner } from '../brain/delegatedTurn.js';
import { SubagentRunnerHost, type RunnerHeartbeat, type SubagentRunnerHostDeps } from './runnerHost.js';
import { FairQueue } from './fairQueue.js';
import type { SpawnFailureCode, SubagentPoolStats } from './poolStats.js';
import type { McpBridgeSnapshot } from '../plugins/mcpSnapshot.js';
import { WORKFLOW_ADD_NODES_RPC, type HostRpcMethod } from './hostRpc.js';
import {
  HEARTBEAT_INTERVAL_MS,
  MAX_TURNS_PER_RUNNER,
  SATURATION_P99_MS,
  canAffordSpawn,
  isReapable,
  isSaturated,
  poolSizing,
  realMachine,
  shouldGrow,
  type MachineInputs,
  type RunnerLoad,
} from './sizing.js';

const log = logger('subagent-pool');

/** How often the pool re-examines itself: reap what has gone idle, retire routes nobody is using, and
 *  reconsider growth for anything still queued. One tick per five heartbeats — the decisions it makes are
 *  all measured in tens of seconds, so a faster sweep would only burn wakeups. */
const MAINTENANCE_INTERVAL_MS = HEARTBEAT_INTERVAL_MS * 5;

/** A route this stale is not a warm session any more — the runner's own channel-session LRU has long
 *  since evicted it. Dropping it lets a future continuation be placed on the least-loaded runner instead
 *  of an arbitrary historical one. NEVER dropped without asking the runner to release it first: a route
 *  is what guarantees one channel is live in ONE process, so forgetting it unilaterally is how the same
 *  transcript ends up driven by two sessions. */
const ROUTE_IDLE_MS = 30 * 60_000;

/** Classify a fork refusal for the public stats block. The raw message is matched here, ONCE, at the
 *  daemon's own trust boundary — outward goes only the category, because `/health` is unauthenticated
 *  and a raw boot exception quotes internal paths, build ids and configuration. The detail an operator
 *  needs is in the daemon log, one line above where this code is recorded. */
const spawnFailureCode = (reason: string): SpawnFailureCode =>
  reason.includes('build mismatch') ? 'build_mismatch'
    : reason.includes('did not report ready') ? 'boot_timeout'
    : reason.includes('refused to start') ? 'boot_failed'
    : 'fork_failed';

interface QueuedTurn {
  request: DelegatedTurnRequest;
  text: string;
  onEvent?: (e: BrainEvent) => void;
  resolve: (reply: string) => void;
  reject: (e: Error) => void;
  queuedAt: number;
}

/** One runner, plus everything the POOL knows about it that the child cannot report. */
interface PooledRunner {
  host: SubagentRunnerHost;
  /** Turns PLACED here and not yet settled. Incremented synchronously at placement, so admission and the
   *  reap decision read an exact number — the heartbeat's own count is up to one beat stale and is used
   *  for reporting only. */
  inFlight: number;
  /** Consecutive heartbeats over SATURATION_P99_MS. Reset by any beat under it — that is what makes the
   *  streak evidence of SUSTAINED load rather than of one spike. */
  saturatedBeats: number;
  /** Last time a turn started or settled here. Drives reaping. */
  lastActivityAt: number;
}

export interface SubagentRunnerPoolDeps extends Omit<SubagentRunnerHostDeps, 'onHeartbeat' | 'onExit' | 'mcpBridgeSnapshot'> {
  /** The daemon's bridged MCP tool definitions, read AT SPAWN TIME — once per fork, never cached here.
   *  That is the whole point: a runner then declares exactly what the daemon's registry holds at the
   *  moment it is created, so an MCP server the operator added or removed since boot needs no
   *  invalidation anywhere. Resolving it touches the plugin registry, hence async; a rejection or an
   *  absent control simply means no snapshot, and the runner connects at boot as before. */
  mcpBridgeSnapshot?: () => Promise<McpBridgeSnapshot | undefined>;
  /** The operator's knob, read LIVE: `null` = auto (size from the machine), 0 = pool off (every delegated
   *  turn stays in-process), N >= 1 = hard cap. Live so raising it takes effect on the next turn. */
  poolMax?: () => number | null;
  /** The operator's switch, as the DISPATCHER reads it. `/health` exists to answer "is the runner
   *  actually carrying my delegated turns", and a pool that only knows its own cap cannot answer that:
   *  it would keep reporting `runner` after the switch was flipped off, which is exactly the moment an
   *  operator is staring at this block to confirm their rollback took. */
  enabled?: () => boolean;
  /** Machine facts. Injected so the sizing rule can be tested at 1/2/16/64 cores and against a container
   *  whose numbers lie, without needing such a box. */
  machine?: MachineInputs;
}

export class SubagentRunnerPool implements DelegatedTurnRunner {
  private readonly runners: PooledRunner[] = [];
  /** channelId → the runner holding that session. A session belongs to ONE runner for its lifetime, so
   *  continuation traffic (collect turns, aborts, nested edges, release) reaches the process that has it. */
  private readonly routes = new Map<string, PooledRunner>();
  private readonly routeTouched = new Map<string, number>();
  private readonly queue = new FairQueue<QueuedTurn>();
  private readonly machine: MachineInputs;
  private childEdgeSink?: (parentSessionId: string, childSessionId: string, running: boolean) => void;
  /** Largest RSS any live runner has reported. Replaces the conservative estimate in sizing once real —
   *  the MAXIMUM rather than the first, because the memory ceiling must hold for the next runner too and
   *  a pool sized off its smallest member is a pool that overcommits. */
  private measuredRss = 0;
  private lastSpawnAt = 0;
  /** Why the last fork failed, as its public category — the CURRENT epoch's failure, not history. A
   *  failure that is only logged is invisible to anyone reading `/health`, and this particular one is
   *  silent by design: the dispatcher catches it and runs the turn in-process, so the delegation still
   *  works and nothing surfaces except a slower daemon. Cleared by a successful spawn, by `reset` and
   *  by the operator switching runner mode off — each of those ends the epoch the failure describes,
   *  and a refusal kept past its epoch is an alarm that can never turn off (`agoMs` growing forever,
   *  `consecutive` no longer meaning a consecutive run). */
  private lastSpawnFailure: { code: SpawnFailureCode; at: number; consecutive: number } | null = null;
  private spawning: Promise<void> | null = null;
  private maintenance: NodeJS.Timeout | null = null;
  /** Bumped by every `reset`. A spawn that was in flight across one belongs to the pool that no longer
   *  exists, so it is torn down instead of joining the new one — otherwise a plugin reload would leave a
   *  runner booted from the OLD build serving turns for the new. */
  private generation = 0;
  /** A stale-route sweep is in flight; see retireStaleRoutes. */
  private retiring = false;
  /** True only WHILE a reset is tearing things down. Deliberately not sticky: `reset` is what a plugin
   *  reload calls, and the pool must come back on the next delegated turn exactly as the single runner it
   *  replaced did. A pool that stayed dead after a reload would silently drop every delegation in-process
   *  until the daemon was restarted. */
  private stopped = false;

  constructor(private d: SubagentRunnerPoolDeps) {
    this.machine = d.machine ?? realMachine();
  }

  attachChildEdgeSink(sink: (parentSessionId: string, childSessionId: string, running: boolean) => void): void {
    this.childEdgeSink = sink;
    for (const r of this.runners) r.host.attachChildEdgeSink(sink);
  }

  /** The operator's knob resolved to a cap, or 0 when the pool is switched off. `SubagentDispatch` asks
   *  before it routes, so a disabled pool reports `in-process` rather than failing a turn per delegation. */
  usable(): boolean { return this.cap() > 0; }

  /** Capability, not optimism: a daemon without the handler keeps WorkflowAddNodes denied in remote nodes. */
  supportsHostRpc(method: HostRpcMethod): boolean {
    return method === WORKFLOW_ADD_NODES_RPC && this.d.hostRpc !== undefined;
  }

  private cap(): number {
    return poolSizing(this.machine, {
      ...(this.measuredRss > 0 ? { measuredRunnerRssBytes: this.measuredRss } : {}),
      operatorMax: this.d.poolMax?.() ?? null,
    }).cap;
  }

  private runnerRssBytes(): number {
    return poolSizing(this.machine, this.measuredRss > 0 ? { measuredRunnerRssBytes: this.measuredRss } : {}).runnerRssBytes;
  }

  async run(request: DelegatedTurnRequest, text: string, onEvent?: (e: BrainEvent) => void): Promise<string> {
    if (this.stopped) throw new SubagentRunnerUnavailable('the sub-agent runner pool is shutting down');
    if (this.cap() === 0) throw new SubagentRunnerUnavailable('the sub-agent runner pool is disabled (pool max 0)');
    const placed = this.place(request);
    if (placed) return this.dispatch(placed, request, text, onEvent);
    // Nothing live could take it. With no runners at all this is a COLD START and the caller is entitled
    // to a straight answer — the dispatcher falls back in-process when the runner cannot be brought up,
    // and swallowing that into an unbounded wait would replace a working delegation with a hang.
    if (this.runners.length === 0) {
      // A failure HERE is the real "unavailable": no runner could be brought up, so the dispatcher running
      // this turn in-process is the difference between a slower delegation and a broken one.
      await this.spawn();
      const cold = this.place(request);
      if (cold) return this.dispatch(cold, request, text, onEvent);
      // A reset landing mid-boot discards the runner we just waited for. Queueing then would park this
      // turn behind a pool that no longer has anything to drain it, so the honest answer is the same one
      // a failed boot gives — there is no runner to be had.
      if (this.stopped || !this.runners.some((r) => !r.host.isDead)) {
        throw new SubagentRunnerUnavailable('the sub-agent runner pool has no live runner for this turn');
      }
      // The runner DID come up and merely has no slot left for this particular turn. That is congestion,
      // not unavailability, so it falls through to the queue below. A burst arriving at a cold pool is
      // exactly when this matters: every turn passes the "no runners yet" test before the first spawn
      // resolves, so refusing here dumped a whole burst minus one runner's worth straight back onto the
      // daemon's event loop — measured as 12 of 20 turns in-process, and the loop stalling for 8s.
    }
    // Runners exist and are all full: QUEUE, never refuse. Growth (if the machine allows it) happens
    // beside this, not in front of it — a turn must not wait on a cold plugin boot to be admitted.
    return new Promise<string>((resolve, reject) => {
      this.queue.push(request.parentSessionId, { request, text, resolve, reject, queuedAt: Date.now(), ...(onEvent ? { onEvent } : {}) });
      this.considerGrowth(true);
    });
  }

  /** The pool's own exact view of one runner's load — what every sizing decision reads. */
  private static load(entry: PooledRunner): RunnerLoad {
    return { activeTurns: entry.inFlight, saturatedBeats: entry.saturatedBeats };
  }

  /** Which runner should take this turn, or undefined when none may. */
  private place(request: DelegatedTurnRequest): PooledRunner | undefined {
    const pinned = this.routes.get(request.channelId);
    if (pinned && !pinned.host.isDead) {
      // A pinned session goes to ITS runner or waits for it — never to another one. Placing it elsewhere
      // while the first still holds the record would drive one transcript from two live sessions.
      return pinned.inFlight < MAX_TURNS_PER_RUNNER ? pinned : undefined;
    }
    // Least loaded first, so work spreads instead of piling onto whoever was asked first.
    const candidates = this.runners.filter((r) => !r.host.isDead && r.inFlight < MAX_TURNS_PER_RUNNER);
    if (candidates.length === 0) return undefined;
    return candidates.reduce((best, r) => (r.inFlight < best.inFlight ? r : best));
  }

  private dispatch(target: PooledRunner, request: DelegatedTurnRequest, text: string, onEvent?: (e: BrainEvent) => void): Promise<string> {
    // A turn that had to be placed on an ALREADY saturated runner is the demand signal the queue cannot
    // give: it DID fit, so nothing is queued, yet the pool is past its comfort line and should grow.
    // Read before the increment, so "saturated" means "already was", not "became so by this very turn".
    const ontoSaturated = isSaturated(SubagentRunnerPool.load(target));
    target.inFlight += 1;
    target.lastActivityAt = Date.now();
    this.routes.set(request.channelId, target);
    this.routeTouched.set(request.channelId, Date.now());
    if (ontoSaturated) this.considerGrowth(true);
    return target.host.run(request, text, onEvent).finally(() => {
      target.inFlight -= 1;
      target.lastActivityAt = Date.now();
      this.drain();
    });
  }

  /** Hand queued turns to whatever room just appeared, in producer rotation. */
  private drain(): void {
    if (this.stopped) return;
    const deferred: QueuedTurn[] = [];
    while (this.hasRoom()) {
      const next = this.queue.shift();
      if (!next) break;
      const target = this.place(next.request);
      // Room exists but not for THIS turn ⇒ it is pinned to a session whose runner is full. Set it aside
      // and keep going: letting one busy session block the head of the queue would stall every other
      // producer behind it, which is the starvation the fair rotation exists to prevent.
      if (!target) { deferred.push(next); continue; }
      this.dispatch(target, next.request, next.text, next.onEvent).then(next.resolve, next.reject);
    }
    // Back to the head of the rotation, in their original order — being offered a slot they could not
    // take must not cost a producer its place in line.
    for (let i = deferred.length - 1; i >= 0; i -= 1) {
      const held = deferred[i] as QueuedTurn;
      this.queue.unshift(held.request.parentSessionId, held);
    }
  }

  private hasRoom(): boolean {
    return this.runners.some((r) => !r.host.isDead && r.inFlight < MAX_TURNS_PER_RUNNER);
  }

  /** Spawn one more runner IF the sustained evidence says so. Fire-and-forget: growth must never be on
   *  the critical path of a turn, or a burst would wait on a cold plugin boot. */
  private considerGrowth(pressure: boolean): void {
    if (this.stopped || this.spawning) return;
    const grow = shouldGrow({
      runners: this.runners.map((r) => SubagentRunnerPool.load(r)),
      pressure,
      cap: this.cap(),
      sinceLastSpawnMs: this.lastSpawnAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - this.lastSpawnAt,
      memoryAllows: canAffordSpawn(this.machine, this.runnerRssBytes()),
    });
    if (!grow) return;
    void this.spawn().catch(() => { /* logged in spawn(); the queue simply keeps time-sharing */ });
  }

  /** Fork one runner and wait for its handshake. Serialized: two concurrent spawns would both see the
   *  same "nothing live" state and fork a pair for one turn's worth of demand. */
  private spawn(): Promise<void> {
    if (this.spawning) return this.spawning;
    const gen = this.generation;
    const attempt = (async (): Promise<void> => {
      const startedAt = Date.now();
      this.lastSpawnAt = startedAt;
      // The START of the fork, not only its outcome: a runner's own boot trace is written from the child,
      // so without this line the daemon's log has no timestamp to measure fork→ready against — and a
      // spawn that never reports ready leaves no trace at all that one was attempted.
      log.info(`sub-agent pool: forking a runner (${this.runners.length} live, cap ${this.cap()})`);
      // Read BEFORE the fork, so the child is handed the registry as it stands right now. Fail-open: a
      // snapshot we could not obtain must never be the reason a delegated turn has no runner — the child
      // then connects its MCP servers itself, which is merely the old, slower boot.
      const mcpBridgeSnapshot = await this.d.mcpBridgeSnapshot?.().catch((e: unknown) => {
        log.warn(`could not snapshot the bridged MCP tools for this runner: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      });
      // The callbacks close over `entry`, which is assigned on the next line — safe because a host never
      // invokes them from its constructor, only from IPC frames that cannot arrive before the fork.
      let entry: PooledRunner;
      const host = new SubagentRunnerHost({
        dbPath: this.d.dbPath,
        project: this.d.project,
        cwd: this.d.cwd,
        ...(mcpBridgeSnapshot ? { mcpBridgeSnapshot } : {}),
        ...(this.d.fork ? { fork: this.d.fork } : {}),
        ...(this.d.hostRpc ? { hostRpc: this.d.hostRpc } : {}),
        onHeartbeat: (beat) => this.onHeartbeat(entry, beat),
        onExit: () => this.onRunnerExit(entry),
      });
      entry = { host, inFlight: 0, saturatedBeats: 0, lastActivityAt: Date.now() };
      if (this.childEdgeSink) host.attachChildEdgeSink(this.childEdgeSink);
      try {
        await host.start();
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        log.warn(`could not add a sub-agent runner: ${reason}`);
        this.lastSpawnFailure = { code: spawnFailureCode(reason), at: Date.now(), consecutive: (this.lastSpawnFailure?.consecutive ?? 0) + 1 };
        throw e;
      }
      // Registered only once it is genuinely up: a half-booted entry in the list would be counted as
      // capacity and would take placements it could not serve. A reset that landed mid-boot makes this
      // runner an orphan of the previous generation — tear it down rather than let it join.
      if (this.stopped || this.generation !== gen) {
        host.reset('the pool was reset while this runner was booting');
        return;
      }
      this.runners.push(entry);
      // A live runner is the only thing that makes a past refusal stop being the pool's current state.
      this.lastSpawnFailure = null;
      this.startMaintenance();
      log.info(`sub-agent pool: runner up in ${Date.now() - startedAt}ms — ${this.runners.length} runner(s) live (cap ${this.cap()})`);
      this.drain();
    })();
    this.spawning = attempt.finally(() => { this.spawning = null; });
    return this.spawning;
  }

  private onHeartbeat(entry: PooledRunner, beat: RunnerHeartbeat): void {
    entry.saturatedBeats = beat.loopP99Ms > SATURATION_P99_MS ? entry.saturatedBeats + 1 : 0;
    // The memory ceiling stops being a guess the moment a real runner reports its size. It only ever
    // grows here: a runner's RSS climbs as it works, and sizing off the low-water mark would let the pool
    // commit to a count the box cannot hold an hour later. Runners already live are never killed for it —
    // the ceiling governs whether we spawn ANOTHER one, not whether the existing ones may continue.
    if (beat.rssBytes > this.measuredRss) this.measuredRss = beat.rssBytes;
    // A heartbeat is not itself demand: it only re-evaluates growth for turns ALREADY waiting. This is
    // the beat that turns a sustained streak into a spawn, once the streak is long enough.
    if (this.queue.depth > 0) this.considerGrowth(true);
  }

  /** The child died. Its turns have already been settled as interrupted by the host, and its nested edges
   *  retracted; what is left is the ROUTING, which only the pool holds — a stale route would send the next
   *  continuation to a process that no longer exists. */
  private onRunnerExit(entry: PooledRunner): void {
    const at = this.runners.indexOf(entry);
    if (at >= 0) this.runners.splice(at, 1);
    for (const [channelId, r] of [...this.routes]) {
      if (r !== entry) continue;
      this.routes.delete(channelId);
      this.routeTouched.delete(channelId);
    }
    entry.inFlight = 0;
    // A later continuation for one of those sessions may now be placed ANYWHERE and rehydrates from
    // SQLite, which is exactly what the daemon does for a child it has never seen.
    this.drain();
    this.considerGrowth(this.queue.depth > 0);
  }

  private startMaintenance(): void {
    if (this.maintenance || this.stopped) return;
    this.maintenance = setInterval(() => this.maintain(), MAINTENANCE_INTERVAL_MS);
    // A housekeeping timer must never hold the daemon open on shutdown.
    this.maintenance.unref?.();
  }

  private maintain(): void {
    if (this.stopped) return;
    const now = Date.now();
    void this.retireStaleRoutes(now);
    for (const entry of [...this.runners]) {
      if (!this.reapable(entry, now)) continue;
      log.info(`sub-agent pool: reaping an idle runner (pid ${entry.host.pid ?? '?'})`);
      // `reset` kills it; the exit path removes it from the list and clears its routes — one removal path,
      // so a reap can never leave a route pointing at a process that is going away.
      entry.host.reset('idle');
    }
    if (this.runners.length === 0 && this.maintenance) {
      clearInterval(this.maintenance);
      this.maintenance = null;
    }
    if (this.queue.depth > 0) { this.drain(); this.considerGrowth(true); }
  }

  /** Empty, unrouted and untouched for long enough — the predicate lives in sizing.ts beside the
   *  saturation one it is the complement of, so the two cannot drift apart unnoticed. */
  private reapable(entry: PooledRunner, now: number): boolean {
    let routedSessions = 0;
    for (const r of this.routes.values()) if (r === entry) routedSessions += 1;
    return isReapable({ activeTurns: entry.inFlight, routedSessions, idleMs: now - entry.lastActivityAt });
  }

  /** Let go of routes nobody has used for ages — but only after the runner confirms it has dropped the
   *  session, never unilaterally, or the same channel could go live in two processes at once. */
  private async retireStaleRoutes(now: number): Promise<void> {
    // A release has no deadline (it settles on the runner's answer or on its death), so a wedged child
    // could otherwise have a fresh sweep pile up behind it on every maintenance tick.
    if (this.retiring) return;
    this.retiring = true;
    try {
      await this.sweepRoutes(now);
    } finally {
      this.retiring = false;
    }
  }

  private async sweepRoutes(now: number): Promise<void> {
    for (const [channelId, entry] of [...this.routes]) {
      if (entry.inFlight > 0) continue;
      if (now - (this.routeTouched.get(channelId) ?? now) < ROUTE_IDLE_MS) continue;
      const { busy } = await entry.host.release(channelId).catch(() => ({ busy: true }));
      if (busy) { this.routeTouched.set(channelId, now); continue; }
      if (this.routes.get(channelId) === entry) {
        this.routes.delete(channelId);
        this.routeTouched.delete(channelId);
      }
    }
  }

  abort(channelId: string): void {
    // Only the process holding the session can interrupt its model call; every other runner has nothing
    // to abort, so broadcasting would be noise. No route ⇒ nothing of ours is running it.
    this.routes.get(channelId)?.host.abort(channelId);
  }

  async steer(channelId: string, text: string): Promise<{ outcome: 'delivered' | 'idle' | 'aborted' }> {
    // Same routing rule as abort: only the runner holding the session can inject into its turn. No route
    // ⇒ no turn of this channel runs in any runner, and the caller delivers the text itself.
    const entry = this.routes.get(channelId);
    if (!entry) return { outcome: 'idle' };
    return entry.host.steer(channelId, text);
  }

  async tapSessionSnapshot(
    userId: number,
    sessionId: string,
    listener: (event: BrainEvent) => void,
    history?: { before?: number; limit: number },
  ): Promise<{ off: () => void; snapshot: BrainStreamSnapshot } | undefined> {
    // Session affinity is the same invariant as steer/abort: only the routed runner owns the replay journal.
    const channelId = channelIdOf(sessionId);
    const entry = this.routes.get(channelId);
    if (!entry) return undefined;
    this.routeTouched.set(channelId, Date.now());
    return entry.host.tapSessionSnapshot(userId, sessionId, listener, history);
  }

  async release(channelId: string): Promise<{ busy: boolean }> {
    const entry = this.routes.get(channelId);
    // Not routed ⇒ no runner holds a record for this channel, by definition of the routing map.
    if (!entry) return { busy: false };
    const result = await entry.host.release(channelId);
    // Released for real: the daemon is about to run this child itself, so the route must go or the next
    // delegated turn would be sent straight back to a runner that no longer has the session.
    if (!result.busy && this.routes.get(channelId) === entry) {
      this.routes.delete(channelId);
      this.routeTouched.delete(channelId);
    }
    return result;
  }

  async activeCount(): Promise<number> {
    const remote = await Promise.all(this.runners.map(async (entry) => {
      try { return Math.max(entry.inFlight, await entry.host.activeCount()); }
      catch { return Math.max(1, entry.inFlight); }
    }));
    return this.queue.depth + remote.reduce((sum, count) => sum + count, 0);
  }

  async killAccountProcesses(userId: number): Promise<number> {
    const killed = await Promise.all(this.runners.map((entry) => entry.host.killAccountProcesses(userId)));
    return killed.reduce((sum, count) => sum + count, 0);
  }

  /** Broadcast the shutdown drain latch to every live runner (see SubagentRunnerHost.beginDrain). */
  beginDrain(): void {
    for (const entry of this.runners) entry.host.beginDrain();
  }

  /** Mid-step turns across the whole pool, for the daemon's step-boundary drain. A poll failure counts
   *  as 1 (fail closed — keep waiting rather than exit under an unobservable turn). Queued turns never
   *  started anywhere, so the queue depth deliberately does NOT count: a draining daemon refuses new
   *  work and whatever is queued is re-dispatched or recovered after the restart. */
  async midStepWork(): Promise<number> {
    const remote = await Promise.all(this.runners.map(async (entry) => {
      try { return await entry.host.midStepWork(); }
      catch { return 1; }
    }));
    return remote.reduce((sum, count) => sum + count, 0);
  }

  reset(reason: string): void {
    this.stopped = true;
    this.generation += 1;
    if (this.maintenance) { clearInterval(this.maintenance); this.maintenance = null; }
    // Nothing of a QUEUED turn ran anywhere, so `SubagentRunnerUnavailable` is literally true for it and
    // lets the dispatcher run it in-process instead of losing it to a plugin reload.
    const stranded = new SubagentRunnerUnavailable(`the sub-agent runner pool stopped: ${reason}`);
    for (const q of this.queue.drain()) q.reject(stranded);
    this.routes.clear();
    this.routeTouched.clear();
    for (const entry of [...this.runners]) entry.host.reset(reason);
    this.runners.length = 0;
    // Cleared, not disabled: the very next delegated turn cold-starts a fresh runner, which is exactly
    // what the single runner this replaced did after a reload.
    this.lastSpawnAt = 0;
    // A reset ends the failure's epoch too. If the environment is still broken, the very next delegated
    // turn re-records a FRESH failure (with a truthful `agoMs` and a `consecutive` that really is
    // consecutive); if it was fixed — which is what a plugin reload often is — the stale alarm is gone.
    this.lastSpawnFailure = null;
    this.stopped = false;
  }

  /** Everything `/health` shows about the pool. Cheap: a map over at most `cap` entries. */
  stats(): SubagentPoolStats {
    const sizing = poolSizing(this.machine, {
      ...(this.measuredRss > 0 ? { measuredRunnerRssBytes: this.measuredRss } : {}),
      operatorMax: this.d.poolMax?.() ?? null,
    });
    const sessions = new Map<PooledRunner, number>();
    for (const entry of this.routes.values()) sessions.set(entry, (sessions.get(entry) ?? 0) + 1);
    const oldest = this.oldestQueuedAt();
    const mode = this.d.enabled?.() !== false && sizing.cap > 0 ? 'runner' : 'in-process';
    // Switching runner mode off ends the failure's epoch the same way `reset` does: the refusal
    // described a pool that no longer forks anything, so keeping it would show a permanently growing
    // `agoMs` for a mode the operator deliberately left.
    if (mode !== 'runner') this.lastSpawnFailure = null;
    return {
      mode,
      cap: sizing.cap,
      cpuCap: sizing.cpuCap,
      memCap: sizing.memCap,
      runnerRssBytes: sizing.runnerRssBytes,
      measuredRunnerRss: this.measuredRss > 0,
      operatorCapped: sizing.operatorCapped,
      queueDepth: this.queue.depth,
      oldestQueuedMs: oldest === undefined ? 0 : Math.max(0, Date.now() - oldest),
      spawnFailure: this.lastSpawnFailure
        ? {
            code: this.lastSpawnFailure.code,
            agoMs: Math.max(0, Date.now() - this.lastSpawnFailure.at),
            consecutive: this.lastSpawnFailure.consecutive,
          }
        : null,
      runners: this.runners.map((r) => ({
        pid: r.host.pid ?? null,
        sessions: sessions.get(r) ?? 0,
        activeTurns: r.inFlight,
        rssBytes: r.host.heartbeat?.rssBytes ?? null,
        loopP99Ms: r.host.heartbeat?.loopP99Ms ?? null,
        saturated: isSaturated(SubagentRunnerPool.load(r)),
      })),
    };
  }

  /** The oldest queued turn's timestamp — how long the pool has been making somebody wait. */
  private oldestQueuedAt(): number | undefined {
    let oldest: number | undefined;
    for (const q of this.queue.entries()) if (oldest === undefined || q.queuedAt < oldest) oldest = q.queuedAt;
    return oldest;
  }
}
